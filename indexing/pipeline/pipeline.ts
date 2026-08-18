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
        private readonly initialOffset: number,
        private readonly colorCode: string
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
            `${this.colorCode}[${language}] Pipeline progress update\x1b[0m`
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

const ANSI_COLORS = [
    "\x1b[38;5;196m", // Red
    "\x1b[38;5;46m",  // Green
    "\x1b[38;5;226m", // Yellow
    "\x1b[38;5;33m",  // Light Blue
    "\x1b[38;5;201m", // Magenta
    "\x1b[38;5;51m",  // Cyan
    "\x1b[38;5;208m", // Orange
    "\x1b[38;5;118m", // Lime Green
    "\x1b[38;5;129m", // Purple
    "\x1b[38;5;27m",  // Deep Blue
    "\x1b[38;5;220m", // Gold
    "\x1b[38;5;165m", // Deep Pink
    "\x1b[38;5;86m",  // Aquamarine
];

async function processLanguageFile(
    filePath: string,
    shardIndex: number,
    offset: number,
    limit: number,
    colorCode: string,
    virtualLangOverride?: string
): Promise<void> {
    const language = virtualLangOverride || path.basename(filePath, path.extname(filePath));
    const shardName = `${language}_shard${shardIndex}`;
    const paths = shardPaths(shardName);

    logger.info(
        { language: shardName, filePath, offset, limit },
        `${colorCode}[${shardName}] Processing file end-to-end (offset: ${offset}, limit: ${limit})\x1b[0m`
    );

    const embedder = createEmbedder();

    const checkpoint = await Checkpoint.loadOrCreate(
        paths.dir,
        shardName,
        filePath
    );

    if (checkpoint.isCompleted) {
        logger.info(
            { language: shardName },
            `${colorCode}[${shardName}] Shard already completed — skipping.\x1b[0m`
        );
        return;
    }

    const indexExists = await VectorIndex.exists(paths.indexFile);
    const index = indexExists
        ? await VectorIndex.load(paths.indexFile)
        : VectorIndex.create();

    const metadata = await MetadataStore.open(
        path.join(paths.dir, "metadata.db")
    );

    const progress = new ProgressTracker(limit, checkpoint.rowsConsumed, colorCode);

    logger.info(
        {
            language: shardName,
            resumeOffset: checkpoint.rowsConsumed,
            totalRows: limit,
            percent: (limit > 0 ? (checkpoint.rowsConsumed / limit * 100).toFixed(2) : "0.00") + "%",
            alreadyIndexed: checkpoint.vectorsIndexed,
        },
        `${colorCode}[${shardName}] Initialized shard parameters (offset: ${offset}, limit: ${limit})\x1b[0m`
    );

    let rowsSeen = 0;
    let rowsConsumedThisRun = 0;
    let vectorsSinceCheckpoint = 0;
    let buffer: Chunk[] = [];

    const persistCheckpoint = async (): Promise<void> => {
        logger.info({ language: shardName }, `${colorCode}[${shardName}] Persisting checkpoint to disk\x1b[0m`);
        await index.save(paths.indexFile);
        metadata.checkpoint();

        checkpoint.recordProgress(rowsConsumedThisRun, vectorsSinceCheckpoint);
        rowsConsumedThisRun = 0;
        vectorsSinceCheckpoint = 0;

        await checkpoint.persist();

        logger.info(
            { language: shardName, totalVectors: index.ntotal },
            `${colorCode}[${shardName}] Checkpoint successfully persisted\x1b[0m`
        );
    };

    const resumeOffset = checkpoint.rowsConsumed;
    const isEnglish = language === "engtrain";

    for await (const rowBatch of streamPassagesFromParquet(filePath, offset, limit, isEnglish)) {
        logger.info(
            { language: shardName, passagesInBatch: rowBatch.length },
            `${colorCode}[${shardName}] Processing unnested batch from parquet rows\x1b[0m`
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
                    shardName
                );
                tasks.push(task);
                vectorsSinceCheckpoint += batch.length;
            }
        }

        // Flush any remaining chunks in the buffer immediately after processing this 20-row batch
        if (buffer.length > 0) {
            logger.info(
                { language: shardName, count: buffer.length },
                `${colorCode}[${shardName}] Flushing remaining chunks for this row batch in safe batches\x1b[0m`
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
                    shardName
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

    progress.maybeReport(shardName, true);
    logger.info(
        { language: shardName, finalIndexSize: index.ntotal },
        `${colorCode}[${shardName}] Completed indexing language shard successfully\x1b[0m`
    );
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

export async function runPipeline(selectedLangs?: string[]): Promise<void> {
    logger.info("Starting streaming chunk + embed + FAISS index pipeline");

    const allFiles = await listParquetFiles(TRAIN_DIR);
    allFiles.sort((a, b) => a.localeCompare(b));

    let parquetFiles = [...allFiles];
    let shouldRunEnglish = false;

    // Filter by selected languages if provided via command-line arguments
    if (selectedLangs && selectedLangs.length > 0) {
        const normalizedSelected = selectedLangs.map((lang) => lang.toLowerCase().trim());
        const hasEng = normalizedSelected.some((l) => l.includes("eng"));
        if (hasEng) {
            shouldRunEnglish = true;
        }

        const nonEngSelections = normalizedSelected.filter((l) => !l.includes("eng"));
        if (nonEngSelections.length > 0) {
            parquetFiles = parquetFiles.filter((filePath) => {
                const langName = path.basename(filePath, path.extname(filePath)).toLowerCase();
                return nonEngSelections.some((sel) => langName.includes(sel) || sel.includes(langName));
            });
        } else {
            parquetFiles = [];
        }
        logger.info({ selectedLangs, matchedPhysicalCount: parquetFiles.length, shouldRunEnglish }, "Filtered files by command-line arguments");
    } else {
        // Run all languages + english by default when no arguments are provided
        shouldRunEnglish = true;
    }

    logger.info(
        {
            directory: TRAIN_DIR,
            physicalFileCount: parquetFiles.length,
            includeEnglish: shouldRunEnglish,
            concurrency: FILE_CONCURRENCY,
            indexRoot: INDEX_ROOT,
        },
        "Configured ingestion variables"
    );

    const fileLimit = pLimit(FILE_CONCURRENCY);
    const tasks: (() => Promise<void>)[] = [];

    for (let i = 0; i < parquetFiles.length; i++) {
        const filePath = parquetFiles[i];
        if (!filePath) continue;

        const totalRows = await getParquetRowCount(filePath).catch(() => 0);
        const halfRows = Math.floor(totalRows / 2);
        const colorCode = ANSI_COLORS[i % ANSI_COLORS.length] || "";

        // Shard 0: first 50%
        tasks.push(() => processLanguageFile(
            filePath,
            0,
            0,
            halfRows,
            colorCode
        ));

        // Shard 1: second 50%
        tasks.push(() => processLanguageFile(
            filePath,
            1,
            halfRows,
            totalRows - halfRows,
            colorCode
        ));
    }

    // 2. Add virtual English lang (engtrain) to tasks using first available physical file
    if (shouldRunEnglish && allFiles.length > 0) {
        const engSourceFile = allFiles[0];
        if (engSourceFile) {
            const totalRows = await getParquetRowCount(engSourceFile).catch(() => 0);
            const halfRows = Math.floor(totalRows / 2);
            const engColor = "\x1b[38;5;15m"; // Bright White for English

            // English Shard 0: first 50%
            tasks.push(() => processLanguageFile(
                engSourceFile,
                0,
                0,
                halfRows,
                engColor,
                "engtrain"
            ));

            // English Shard 1: second 50%
            tasks.push(() => processLanguageFile(
                engSourceFile,
                1,
                halfRows,
                totalRows - halfRows,
                engColor,
                "engtrain"
            ));
        }
    }

    await Promise.all(
        tasks.map((task) => fileLimit(task))
    );

    logger.info("All language files successfully processed and indexed");
}
