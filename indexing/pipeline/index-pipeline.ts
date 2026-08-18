// ─────────────────────────────────────────────
// indexing/index-pipeline.ts
// ─────────────────────────────────────────────
//
// Orchestrates: parquet stream -> chunk -> embed (bounded
// batches) -> FAISS add -> metadata insert -> periodic
// checkpoint, per language, with FILE_CONCURRENCY
// languages running at once.
//
// Memory discipline: at any moment, the only data held in
// memory per file is (a) the current DuckDB row batch
// (~2048 rows, from the existing streaming get-data.ts),
// (b) up to MAX_PENDING_EMBEDDING_BATCHES embed/index
// tasks in flight, each holding at most EMBEDDING_BATCH_SIZE
// chunks + their vectors. Nothing accumulates for the
// life of the file — no `allChunks`, no `allEmbeddings`.
// ─────────────────────────────────────────────

import path from "node:path";
import pLimit from "p-limit";

import streamPassagesFromParquet, {
    listParquetFiles,
} from "../get-data.ts";
import chunkPassage from "../chunk-data.ts";
import type { Chunk } from "../types.ts";

import {
    CHECKPOINT_EVERY_N_VECTORS,
    EMBEDDING_BATCH_SIZE,
    FILE_CONCURRENCY,
    INDEX_ROOT,
    MAX_PENDING_EMBEDDING_BATCHES,
    PROGRESS_EVERY_N_PASSAGES,
    TRAIN_DIR,
} from "./config.ts";
import { createEmbedder, type Embedder } from "./embedder.ts";
import { VectorIndex } from "./faiss-index.ts";
import { MetadataStore } from "./metadata-store.ts";
import { Checkpoint } from "./checkpoint.ts";

// ─────────────────────────────────────────────
// Per-language shard state
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

        console.log(
            `[${language}] passages=${this.passages.toLocaleString()} ` +
            `chunks=${this.chunks.toLocaleString()} ` +
            `vectors=${this.vectors.toLocaleString()} ` +
            `throughput=${throughput.toFixed(0)} vec/s ` +
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

    const progress = new ProgressTracker();

    console.log(
        `[${language}] starting — resume offset: ${checkpoint.rowsConsumed.toLocaleString()} rows, ` +
        `${checkpoint.vectorsIndexed.toLocaleString()} vectors already indexed.`
    );

    // Bounds how many embed+index tasks run concurrently. This
    // is what stands in for "maximum pending embeddings" —
    // beyond this many batches in flight, we simply don't
    // schedule more until one finishes, so pending work is
    // capped at MAX_PENDING_EMBEDDING_BATCHES * EMBEDDING_BATCH_SIZE
    // chunks/vectors at any instant.
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

async function main(): Promise<void> {
    console.log("\nStarting embedding + FAISS indexing pipeline...\n");

    const embedder = createEmbedder();
    console.log(`Embedder: provider (see EMBEDDING_PROVIDER), model="${embedder.model}", dim=${embedder.dimension}\n`);

    const parquetFiles = await listParquetFiles(TRAIN_DIR);
    console.log(`Found ${parquetFiles.length} language files. Concurrency: ${FILE_CONCURRENCY}\n`);

    const fileLimit = pLimit(FILE_CONCURRENCY);

    await Promise.all(
        parquetFiles.map((filePath) =>
            fileLimit(() => processLanguageFile(filePath, embedder))
        )
    );

    console.log("\nAll languages indexed.");
}

await main();
