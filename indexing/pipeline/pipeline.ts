// ─────────────────────────────────────────────
// pipeline.ts
// ─────────────────────────────────────────────
//
// Single entrypoint: parquet -> stream -> chunk -> embed
// -> FAISS index -> persisted vectors + metadata.
//
// No JSONL is written. The only durable output is:
//   {INDEX_ROOT}/<language>/index.faiss
//   {INDEX_ROOT}/<language>/metadata.db
//   {INDEX_ROOT}/<language>/state.json   (resume checkpoint)
//
// Memory discipline: at any moment, only the current
// DuckDB row batch (~2048 rows) and up to
// MAX_PENDING_EMBEDDING_BATCHES in-flight embed/index
// batches are held in memory. Nothing accumulates for
// the life of a file.
// ─────────────────────────────────────────────

import path from "node:path";
import pLimit from "p-limit";

import streamPassagesFromParquet, { listParquetFiles, getParquetRowCount } from "./get-data.js";
import chunkPassage from "./chunk-data.js";
import type { Chunk } from "./types.ts";

import {
    CHECKPOINT_EVERY_N_VECTORS,
    EMBEDDING_BATCH_SIZE,
    FILE_CONCURRENCY,
    INDEX_ROOT,
    MAX_PENDING_EMBEDDING_BATCHES,
    PROGRESS_EVERY_N_PASSAGES,
    TRAIN_DIR,
} from "./config.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { VectorIndex } from "./faiss-index.js";
import { MetadataStore } from "./metadata-store.js";
import { Checkpoint } from "./checkpoint.js";

// ─────────────────────────────────────────────
// Per-language shard paths
// ─────────────────────────────────────────────

interface ShardPaths {
    dir: string;
    indexFile: string;
}

function shardPaths(language: string): ShardPaths {
    const dir = path.join(INDEX_ROOT, language);
    return {
        dir,
        indexFile: path.join(dir, "index.faiss"),
    };
}

// ─────────────────────────────────────────────
// Progress tracking (per language)
// ─────────────────────────────────────────────

class ProgressTracker {
    private passages = 0;
    private chunks = 0;
    private vectors = 0;
    private readonly startedAt = Date.now();
    private lastReportAt = Date.now();
    private lastReportVectors = 0;

    constructor(
        private readonly totalRows: number,
        private readonly initialOffset: number
    ) {}

    recordPassage(): void {
        this.passages++;
    }

    recordChunks(n: number): void {
        this.chunks += n;
    }

    recordVectors(n: number): void {
        this.vectors += n;
    }

    maybeReport(language: string, force = false): void {
        if (!force && this.passages % PROGRESS_EVERY_N_PASSAGES !== 0) {
            return;
        }

        const now = Date.now();
        const elapsedSec = (now - this.startedAt) / 1000;
        const sinceLastSec = Math.max((now - this.lastReportAt) / 1000, 0.001);
        const vectorsSinceLast = this.vectors - this.lastReportVectors;
        const throughput = vectorsSinceLast / sinceLastSec;

        const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

        const currentTotal = this.initialOffset + this.passages;
        const percent = this.totalRows > 0 ? (currentTotal / this.totalRows * 100).toFixed(2) : "0.00";

        console.log(
            `[${language}] passages=${currentTotal.toLocaleString()}/${this.totalRows.toLocaleString()} (${percent}%) ` +
            `chunks=${this.chunks.toLocaleString()} ` +
            `vectors=${this.vectors.toLocaleString()} ` +
            `throughput=${throughput.toFixed(1)} vec/s ` +
            `rss=${memMb}MB elapsed=${(elapsedSec / 60).toFixed(1)}min`
        );

        this.lastReportAt = now;
        this.lastReportVectors = this.vectors;
    }
}

// ─────────────────────────────────────────────
// Embed + index one batch of chunks
// ─────────────────────────────────────────────

async function embedAndIndexBatch(
    chunks: Chunk[],
    faissIdStart: number,
    embedder: Embedder,
    index: VectorIndex,
    metadata: MetadataStore,
    progress: ProgressTracker,
    language: string
): Promise<void> {

    const texts = chunks.map((chunk) => chunk.text);
    const vectors = await embedder.embed(texts);

    const ids = chunks.map((_, i) => BigInt(faissIdStart + i));

    index.addBatch(ids, vectors);
    metadata.addBatch(ids, chunks);

    progress.recordVectors(chunks.length);
    progress.maybeReport(language);
}

// ─────────────────────────────────────────────
// Process one language's parquet file end-to-end
// ─────────────────────────────────────────────

async function processLanguageFile(
    filePath: string,
    embedder: Embedder
): Promise<void> {

    const language = path.basename(filePath, path.extname(filePath));
    const paths = shardPaths(language);

    const checkpoint = await Checkpoint.loadOrCreate(
        paths.dir,
        language,
        filePath
    );

    if (checkpoint.isCompleted) {
        console.log(`[${language}] already completed — skipping.`);
        return;
    }

    const indexExists = await VectorIndex.exists(paths.indexFile);
    const index = indexExists
        ? await VectorIndex.load(paths.indexFile)
        : VectorIndex.create();

    const metadata = await MetadataStore.open(
        path.join(paths.dir, "metadata.db")
    );

    const totalRows = await getParquetRowCount(filePath).catch(() => 0);
    const progress = new ProgressTracker(totalRows, checkpoint.rowsConsumed);

    console.log(
        `[${language}] starting — resume offset: ${checkpoint.rowsConsumed.toLocaleString()} / ${totalRows.toLocaleString()} rows ` +
        `(${(totalRows > 0 ? (checkpoint.rowsConsumed / totalRows * 100).toFixed(2) : "0.00")}%), ` +
        `${checkpoint.vectorsIndexed.toLocaleString()} vectors already indexed.`
    );

    // Bounds how many embed+index tasks run concurrently, so
    // pending work never exceeds
    // MAX_PENDING_EMBEDDING_BATCHES * EMBEDDING_BATCH_SIZE
    // chunks/vectors in flight at once.
    const embedLimit = pLimit(MAX_PENDING_EMBEDDING_BATCHES);

    let rowsSeen = 0;
    let rowsConsumedThisRun = 0;
    let vectorsSinceCheckpoint = 0;
    let buffer: Chunk[] = [];
    const inFlight: Promise<void>[] = [];

    const flushBuffer = (): void => {
        if (buffer.length === 0) return;

        const batch = buffer;
        buffer = [];

        const faissIdStart = checkpoint.reserveIds(batch.length);

        const task = embedLimit(() =>
            embedAndIndexBatch(
                batch,
                faissIdStart,
                embedder,
                index,
                metadata,
                progress,
                language
            )
        );

        inFlight.push(task);
        vectorsSinceCheckpoint += batch.length;
    };

    const drainInFlight = async (): Promise<void> => {
        await Promise.all(inFlight);
        inFlight.length = 0;
    };

    const persistCheckpoint = async (): Promise<void> => {
        // Save index + metadata BEFORE advancing the checkpoint
        // file, so a crash between these calls just means
        // resuming redoes a little work — never that we believe
        // we're further along than what's durably on disk.
        await index.save(paths.indexFile);
        metadata.checkpoint();

        checkpoint.recordProgress(rowsConsumedThisRun, vectorsSinceCheckpoint);
        rowsConsumedThisRun = 0;
        vectorsSinceCheckpoint = 0;

        await checkpoint.persist();

        console.log(
            `[${language}] checkpoint saved — ${index.ntotal.toLocaleString()} vectors total.`
        );
    };

    const resumeOffset = checkpoint.rowsConsumed;

    for await (const rowBatch of streamPassagesFromParquet(filePath)) {
        for (const row of rowBatch) {
            rowsSeen++;

            // Skip rows already durably indexed in a prior run.
            if (rowsSeen <= resumeOffset) {
                continue;
            }

            progress.recordPassage();

            const chunks = await chunkPassage(row);
            progress.recordChunks(chunks.length);

            buffer.push(...chunks);
            rowsConsumedThisRun++;

            if (buffer.length >= EMBEDDING_BATCH_SIZE) {
                flushBuffer();
            }

            if (vectorsSinceCheckpoint >= CHECKPOINT_EVERY_N_VECTORS) {
                await drainInFlight();
                await persistCheckpoint();
            }
        }
    }

    flushBuffer();
    await drainInFlight();
    await persistCheckpoint();

    checkpoint.markCompleted();
    await checkpoint.persist();

    metadata.close();

    progress.maybeReport(language, true);
    console.log(`[${language}] done. Final index size: ${index.ntotal.toLocaleString()} vectors.`);
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

export async function runPipeline(): Promise<void> {
    console.log("\nStarting streaming chunk + embed + FAISS index pipeline...\n");

    const embedder = createEmbedder();
    console.log(`Embedder: model="${embedder.model}", dim=${embedder.dimension}\n`);

    const parquetFiles = await listParquetFiles(TRAIN_DIR);
    console.log(`Found ${parquetFiles.length} language files in ${TRAIN_DIR}. Concurrency: ${FILE_CONCURRENCY}\n`);
    console.log(`Indexes will be saved under ${INDEX_ROOT}\n`);

    const fileLimit = pLimit(FILE_CONCURRENCY);

    await Promise.all(
        parquetFiles.map((filePath) =>
            fileLimit(() => processLanguageFile(filePath, embedder))
        )
    );

    console.log("\nAll languages indexed.");
}
