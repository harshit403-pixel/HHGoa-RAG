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
// DuckDB row batch (~20 rows) and in-flight embed/index
// batches are held in memory. Nothing accumulates for
// the life of a file.
// ─────────────────────────────────────────────

import path from "node:path";
import pLimit from "p-limit";
import logger from "./logger.js";

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
    const indexFile = path.join(dir, "index.faiss");
    return { dir, indexFile };
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

        logger.info(
            {
                language,
                progress: `${currentTotal.toLocaleString()}/${this.totalRows.toLocaleString()}`,
                percent: `${percent}%`,
                chunks: this.chunks,
                vectors: this.vectors,
                throughput: `${throughput.toFixed(1)} vec/s`,
                memory: `${memMb}MB`,
                elapsed: `${(elapsedSec / 60).toFixed(1)}min`,
            },
            "Pipeline progress update"
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
    logger.info(
        { language, batchSize: chunks.length, idStart: faissIdStart },
        "Beginning embed + index step for batch"
    );

    const texts = chunks.map((chunk) => chunk.text);
    const vectors = await embedder.embed(texts);

    const ids = chunks.map((_, i) => BigInt(faissIdStart + i));

    logger.debug({ language, count: ids.length }, "Adding vectors to FAISS index");
    index.addBatch(ids, vectors);

    logger.debug({ language, count: ids.length }, "Adding chunks to SQLite metadata store");
    metadata.addBatch(ids, chunks);

    progress.recordVectors(chunks.length);
    progress.maybeReport(language);

    logger.info(
        { language, batchSize: chunks.length, totalVectors: index.ntotal },
        "Completed embed + index step for batch"
    );
}

// ─────────────────────────────────────────────
// Process one language's parquet file end-to-end
// ─────────────────────────────────────────────

async function processLanguageFile(
    filePath: string
): Promise<void> {
    const language = path.basename(filePath, path.extname(filePath));
    const paths = shardPaths(language);

    logger.info({ language, filePath }, "Processing file end-to-end");

    const embedder = createEmbedder();

    const checkpoint = await Checkpoint.loadOrCreate(
        paths.dir,
        language,
        filePath
    );

    if (checkpoint.isCompleted) {
        logger.info({ language }, "File already completed — skipping.");
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

    logger.info(
        {
            language,
            resumeOffset: checkpoint.rowsConsumed,
            totalRows,
            percent: (totalRows > 0 ? (checkpoint.rowsConsumed / totalRows * 100).toFixed(2) : "0.00") + "%",
            alreadyIndexed: checkpoint.vectorsIndexed,
        },
        "Initialized shard parameters"
    );

    let rowsSeen = 0;
    let rowsConsumedThisRun = 0;
    let vectorsSinceCheckpoint = 0;
    let buffer: Chunk[] = [];

    const persistCheckpoint = async (): Promise<void> => {
        logger.info({ language }, "Persisting checkpoint to disk");
        await index.save(paths.indexFile);
        metadata.checkpoint();

        checkpoint.recordProgress(rowsConsumedThisRun, vectorsSinceCheckpoint);
        rowsConsumedThisRun = 0;
        vectorsSinceCheckpoint = 0;

        await checkpoint.persist();

        logger.info(
            { language, totalVectors: index.ntotal },
            "Checkpoint successfully persisted"
        );
    };

    const resumeOffset = checkpoint.rowsConsumed;

    for await (const rowBatch of streamPassagesFromParquet(filePath)) {
        logger.info(
            { language, passagesInBatch: rowBatch.length },
            "Processing unnested batch from parquet rows"
        );

        const tasks: Promise<void>[] = [];

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

            // Convert and index chunks in batches of EMBEDDING_BATCH_SIZE
            while (buffer.length >= EMBEDDING_BATCH_SIZE) {
                const batch = buffer.slice(0, EMBEDDING_BATCH_SIZE);
                buffer = buffer.slice(EMBEDDING_BATCH_SIZE);

                const faissIdStart = checkpoint.reserveIds(batch.length);
                const task = embedAndIndexBatch(
                    batch,
                    faissIdStart,
                    embedder,
                    index,
                    metadata,
                    progress,
                    language
                );
                tasks.push(task);
                vectorsSinceCheckpoint += batch.length;
            }
        }

        // Flush any remaining chunks in the buffer immediately after processing this 20-row batch
        if (buffer.length > 0) {
            logger.info(
                { language, count: buffer.length },
                "Flushing remaining chunks for this row batch in safe batches"
            );
            while (buffer.length > 0) {
                const batch = buffer.slice(0, EMBEDDING_BATCH_SIZE);
                buffer = buffer.slice(EMBEDDING_BATCH_SIZE);

                const faissIdStart = checkpoint.reserveIds(batch.length);
                const task = embedAndIndexBatch(
                    batch,
                    faissIdStart,
                    embedder,
                    index,
                    metadata,
                    progress,
                    language
                );
                tasks.push(task);
                vectorsSinceCheckpoint += batch.length;
            }
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }

        if (vectorsSinceCheckpoint >= CHECKPOINT_EVERY_N_VECTORS) {
            await persistCheckpoint();
        }
    }

    // Final clean up and flush
    if (vectorsSinceCheckpoint > 0) {
        await persistCheckpoint();
    }

    checkpoint.markCompleted();
    await checkpoint.persist();

    metadata.close();

    progress.maybeReport(language, true);
    logger.info(
        { language, finalIndexSize: index.ntotal },
        "Completed indexing language file successfully"
    );
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

export async function runPipeline(): Promise<void> {
    logger.info("Starting streaming chunk + embed + FAISS index pipeline");

    const parquetFiles = await listParquetFiles(TRAIN_DIR);
    // Sort files alphabetically to ensure deterministic order (1st file, 2nd file, etc.)
    parquetFiles.sort((a, b) => a.localeCompare(b));

    logger.info(
        {
            directory: TRAIN_DIR,
            fileCount: parquetFiles.length,
            concurrency: FILE_CONCURRENCY,
            indexRoot: INDEX_ROOT,
        },
        "Configured ingestion variables"
    );

    const fileLimit = pLimit(FILE_CONCURRENCY);

    await Promise.all(
        parquetFiles.map((filePath) =>
            fileLimit(() => processLanguageFile(filePath))
        )
    );

    logger.info("All language files successfully processed and indexed");
}
