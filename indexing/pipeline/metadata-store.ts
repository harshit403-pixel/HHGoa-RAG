// ─────────────────────────────────────────────
// indexing/metadata-store.ts
// ─────────────────────────────────────────────
//
// Persistent chunk_id -> metadata mapping, keyed by the
// same external ID used as the FAISS vector's ID (see
// faiss-index.ts's IndexIDMap2 usage).
//
// SQLite over JSONL/Parquet here because we need POINT
// lookups by ID after a search (search() does N lookups
// for N results), which SQLite indexes natively; JSONL
// would mean scanning, and re-loading a Parquet file per
// query is far too slow. better-sqlite3 is synchronous
// and WAL-mode, so batched inserts are fast and the file
// is safe to read while a writer is mid-transaction.
//
// The full metadata table is NEVER loaded into memory —
// every operation here is a prepared statement against
// the on-disk (WAL) database.
// ─────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import type { Chunk } from "./types.ts";

export interface ChunkMetadata extends Chunk {
    faiss_id: number;
}

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS chunks (
        faiss_id       INTEGER PRIMARY KEY,
        chunk_id       TEXT NOT NULL,
        parent_id      TEXT NOT NULL,
        text           TEXT NOT NULL,
        query_id       INTEGER NOT NULL,
        language       TEXT NOT NULL,
        passage_index  INTEGER NOT NULL,
        is_selected    INTEGER NOT NULL,
        chunk_index    INTEGER NOT NULL,
        chunk_type     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_chunk_id ON chunks(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_parent_id ON chunks(parent_id);
`;

export class MetadataStore {
    private readonly db: Database.Database;
    private readonly insertStatement: Database.Statement;
    private readonly getByIdStatement: Database.Statement;

    private constructor(db: Database.Database) {
        this.db = db;

        this.db.pragma("journal_mode = WAL");
        // synchronous = NORMAL is the standard WAL-mode
        // tradeoff: durable across process crashes, and
        // only risks the last few uncommitted transactions
        // on an actual OS-level power loss — acceptable
        // here since we checkpoint explicitly anyway.
        this.db.pragma("synchronous = NORMAL");

        this.db.exec(SCHEMA);

        this.insertStatement = this.db.prepare(`
            INSERT OR REPLACE INTO chunks (
                faiss_id, chunk_id, parent_id, text, query_id,
                language, passage_index, is_selected, chunk_index, chunk_type
            ) VALUES (
                @faiss_id, @chunk_id, @parent_id, @text, @query_id,
                @language, @passage_index, @is_selected, @chunk_index, @chunk_type
            )
        `);

        this.getByIdStatement = this.db.prepare(
            `SELECT * FROM chunks WHERE faiss_id = ?`
        );
    }

    static async open(filePath: string): Promise<MetadataStore> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const db = new Database(filePath);
        return new MetadataStore(db);
    }

    /**
     * Batched insert inside a single transaction — this is
     * what makes ingesting millions of rows fast with
     * SQLite; one transaction per embedding batch, not one
     * per row.
     */
    addBatch(faissIds: bigint[], chunks: Chunk[]): void {
        if (faissIds.length !== chunks.length) {
            throw new Error(
                `faissIds.length (${faissIds.length}) !== chunks.length (${chunks.length})`
            );
        }

        const insertMany = this.db.transaction((rows: ChunkMetadata[]) => {
            for (const row of rows) {
                this.insertStatement.run({
                    faiss_id: row.faiss_id,
                    chunk_id: row.chunk_id,
                    parent_id: row.parent_id,
                    text: row.text,
                    query_id: row.query_id,
                    language: row.language,
                    passage_index: row.passage_index,
                    is_selected: row.is_selected ? 1 : 0,
                    chunk_index: row.chunk_index,
                    chunk_type: row.chunk_type,
                });
            }
        });

        const rows: ChunkMetadata[] = chunks.map((chunk, i) => ({
            ...chunk,
            faiss_id: Number(faissIds[i]),
        }));

        insertMany(rows);
    }

    getByFaissId(faissId: number): ChunkMetadata | undefined {
        const row = this.getByIdStatement.get(faissId) as
            | (Omit<ChunkMetadata, "is_selected"> & { is_selected: number })
            | undefined;

        if (!row) return undefined;

        return {
            ...row,
            is_selected: row.is_selected === 1,
        };
    }

    getByFaissIds(faissIds: number[]): Map<number, ChunkMetadata> {
        const result = new Map<number, ChunkMetadata>();
        for (const id of faissIds) {
            const row = this.getByFaissId(id);
            if (row) result.set(id, row);
        }
        return result;
    }

    /**
     * Force a WAL checkpoint so the main .db file reflects
     * everything written so far — call this alongside
     * VectorIndex.save() so a checkpoint's index and
     * metadata are consistent snapshots of the same point
     * in the stream.
     */
    checkpoint(): void {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
    }

    close(): void {
        this.db.close();
    }
}
