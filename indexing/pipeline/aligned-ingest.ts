import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import streamPassagesFromParquet from "./get-data.ts";
import { createEmbedder } from "./embedder.ts";
import { VectorIndex } from "./faiss-index.ts";
import { INDEX_ROOT, EMBEDDING_BATCH_SIZE } from "./config.ts";
import logger from "./logger.ts";
import type { Chunk } from "./types.ts";

const TOTAL_ROWS = 778638;
const DEFAULT_NUM_SHARDS = 10;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS chunks (
        faiss_id       INTEGER PRIMARY KEY,
        chunk_id       TEXT NOT NULL,
        parent_id      TEXT NOT NULL,
        text           TEXT NOT NULL,
        query_id       INTEGER NOT NULL,
        passage_index  INTEGER NOT NULL,
        chunk_index    INTEGER NOT NULL,
        chunk_type     TEXT NOT NULL,
        translations   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_query_passage ON chunks(query_id, passage_index);
`;

export class AlignedMetadataStore {
    private readonly db: Database.Database;
    private readonly insertStatement: Database.Statement;

    constructor(dbFile: string) {
        fsSync.mkdirSync(path.dirname(dbFile), { recursive: true });
        this.db = new Database(dbFile);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.exec(SCHEMA);

        this.insertStatement = this.db.prepare(`
            INSERT OR REPLACE INTO chunks (
                faiss_id, chunk_id, parent_id, text, query_id,
                passage_index, chunk_index, chunk_type, translations
            ) VALUES (
                @faiss_id, @chunk_id, @parent_id, @text, @query_id,
                @passage_index, @chunk_index, @chunk_type, @translations
            )
        `);
    }

    addBatch(faissIds: bigint[], chunks: Chunk[]): void {
        const insertMany = this.db.transaction((rows: any[]) => {
            for (const row of rows) {
                this.insertStatement.run(row);
            }
        });

        const rows = chunks.map((chunk, i) => ({
            faiss_id: Number(faissIds[i]),
            chunk_id: chunk.chunk_id,
            parent_id: chunk.parent_id,
            text: chunk.text,
            query_id: chunk.query_id,
            passage_index: chunk.passage_index,
            chunk_index: chunk.chunk_index,
            chunk_type: chunk.chunk_type,
            translations: "{}", // Empty JSON initially
        }));

        insertMany(rows);
    }

    checkpoint(): void {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
    }

    close(): void {
        this.db.close();
    }
}

class IngestionCheckpoint {
    constructor(
        readonly filePath: string,
        public rowsConsumed = 0,
        public vectorsIndexed = 0,
        public nextFaissId = 0,
        public completed = false
    ) {}

    static async loadOrCreate(filePath: string, startFaissId: number): Promise<IngestionCheckpoint> {
        try {
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = JSON.parse(raw);
            return new IngestionCheckpoint(
                filePath,
                parsed.rowsConsumed,
                parsed.vectorsIndexed,
                parsed.nextFaissId,
                parsed.completed
            );
        } catch {
            return new IngestionCheckpoint(filePath, 0, 0, startFaissId, false);
        }
    }

    async save(): Promise<void> {
        const payload = {
            rowsConsumed: this.rowsConsumed,
            vectorsIndexed: this.vectorsIndexed,
            nextFaissId: this.nextFaissId,
            completed: this.completed,
            updatedAt: new Date().toISOString(),
        };
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp-${process.pid}`;
        await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
        await fs.rename(tmp, this.filePath);
    }

    reserveIds(count: number): number {
        const start = this.nextFaissId;
        this.nextFaissId += count;
        return start;
    }
}

/**
 * Main ingestion entrypoint for a single English shard worker
 */
export async function runIngest(shardIndex: number, numShards = DEFAULT_NUM_SHARDS): Promise<void> {
    const shardName = `aligned_shard${shardIndex}`;
    const shardDir = path.join(INDEX_ROOT, shardName);
    const colorCode = `\x1b[38;5;${(shardIndex * 3 + 120) % 256}m`;

    logger.info({ shardIndex, numShards, shardDir }, `${colorCode}[${shardName}] Starting aligned ingestion worker\x1b[0m`);

    const limit = 3000;
    const offset = shardIndex * limit;
    const finalLimit = limit;

    // Determine FAISS ID namespace to avoid collisions when merging later
    // Each shard gets 50,000,000 slots
    const startFaissId = shardIndex * 50_000_000;

    const checkpoint = await IngestionCheckpoint.loadOrCreate(
        path.join(shardDir, "state.json"),
        startFaissId
    );

    if (checkpoint.completed) {
        logger.info(`${colorCode}[${shardName}] Shard already completed - skipping.\x1b[0m`);
        return;
    }

    // Initialize Embedder, FAISS Index, and Metadata SQLite database
    const embedder = createEmbedder(shardIndex);
    const indexFile = path.join(shardDir, "index.faiss");
    const dbFile = path.join(shardDir, "metadata.db");

    let index: VectorIndex;
    if (fsSync.existsSync(indexFile)) {
        index = await VectorIndex.load(indexFile);
    } else {
        index = VectorIndex.create({ dimension: embedder.dimension, indexType: "hnsw" });
    }

    const metadata = new AlignedMetadataStore(dbFile);

    const asmtrainPath = path.join("/data/hfData/train", "asmtrain.parquet");
    const resumeOffset = checkpoint.rowsConsumed;

    let rowsSeen = 0;
    let rowsConsumedThisRun = 0;
    let buffer: Chunk[] = [];
    let vectorsSinceCheckpoint = 0;
    let lastCheckpointAt = Date.now();

    const startedAt = Date.now();
    let lastReportAt = Date.now();
    let lastReportVectors = index.ntotal - startFaissId;
    let lastReportPassages = 0;

    async function persistCheckpoint() {
        await index.save(indexFile);
        metadata.checkpoint();
        checkpoint.rowsConsumed += rowsConsumedThisRun;
        checkpoint.vectorsIndexed = index.ntotal - startFaissId;
        await checkpoint.save();
        vectorsSinceCheckpoint = 0;
        rowsConsumedThisRun = 0;
        logger.info(`${colorCode}[${shardName}] Checkpoint persisted successfully\x1b[0m`);
    }

    async function embedAndIndexBatch(batch: Chunk[], idStart: number) {
        const textBatch = batch.map((c) => c.text);
        const embeddings = await embedder.embed(textBatch);
        
        const ids = Array.from({ length: batch.length }, (_, idx) => BigInt(idStart + idx));
        index.addBatch(ids, embeddings);
        metadata.addBatch(ids, batch);
    }

    for await (const rowBatch of streamPassagesFromParquet(asmtrainPath, offset, finalLimit, true)) {
        const tasks: Promise<void>[] = [];

        for (const row of rowBatch) {
            rowsSeen++;

            // Skip rows already indexed in a prior run
            if (rowsSeen <= resumeOffset) {
                continue;
            }

            const parentId = `${row.query_id}-p${row.passage_index}`;
            const chunks: Chunk[] = [{
                chunk_id: `${parentId}-c0`,
                parent_id: parentId,
                text: row.passage,
                query_id: row.query_id,
                language: "eng",
                passage_index: row.passage_index,
                is_selected: row.is_selected,
                chunk_index: 0,
                chunk_type: "whole"
            }];

            buffer.push(...chunks);
            rowsConsumedThisRun++;

            while (buffer.length >= EMBEDDING_BATCH_SIZE) {
                const batch = buffer.slice(0, EMBEDDING_BATCH_SIZE);
                buffer = buffer.slice(EMBEDDING_BATCH_SIZE);

                const faissIdStart = checkpoint.reserveIds(batch.length);
                const task = embedAndIndexBatch(batch, faissIdStart);
                tasks.push(task);
                vectorsSinceCheckpoint += batch.length;
            }
        }

        if (buffer.length > 0) {
            while (buffer.length > 0) {
                const batch = buffer.slice(0, EMBEDDING_BATCH_SIZE);
                buffer = buffer.slice(EMBEDDING_BATCH_SIZE);

                const faissIdStart = checkpoint.reserveIds(batch.length);
                const task = embedAndIndexBatch(batch, faissIdStart);
                tasks.push(task);
                vectorsSinceCheckpoint += batch.length;
            }
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }

        // Periodic Checkpointing (every 60s or 50k vectors)
        const timeSinceLastCheckpoint = Date.now() - lastCheckpointAt;
        if (vectorsSinceCheckpoint >= 50000 || (vectorsSinceCheckpoint > 0 && timeSinceLastCheckpoint >= 60000)) {
            await persistCheckpoint();
            lastCheckpointAt = Date.now();
        }

        // Progress logging
        const now = Date.now();
        const timeSinceLast = now - lastReportAt;
        if (timeSinceLast >= 15000) {
            const currentTotal = checkpoint.rowsConsumed + rowsConsumedThisRun;
            const percent = finalLimit > 0 ? (currentTotal / finalLimit * 100).toFixed(2) : "0.00";
            
            const totalIndexed = index.ntotal - startFaissId;
            const elapsedSec = (now - startedAt) / 1000;
            const sinceLastSec = Math.max((now - lastReportAt) / 1000, 0.001);
            const vectorsSinceLast = totalIndexed - lastReportVectors;
            const throughput = vectorsSinceLast / sinceLastSec;
            
            const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

            logger.info(
                {
                    progress: `${currentTotal.toLocaleString()}/${finalLimit.toLocaleString()} rows`,
                    percent: `${percent}%`,
                    vectors: totalIndexed,
                    throughput: `${throughput.toFixed(1)} vec/s`,
                    memory: `${memMb}MB`,
                    elapsed: `${(elapsedSec / 60).toFixed(1)}min`,
                },
                `${colorCode}[${shardName}] Shard Progress Update\x1b[0m`
            );

            lastReportAt = now;
            lastReportVectors = totalIndexed;
        }
    }

    // Final persist
    await persistCheckpoint();
    
    checkpoint.completed = true;
    await checkpoint.save();

    metadata.close();
    logger.info(`${colorCode}[${shardName}] Completed aligned indexing shard successfully.\x1b[0m`);
}
