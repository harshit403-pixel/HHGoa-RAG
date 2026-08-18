// ─────────────────────────────────────────────
// indexing/checkpoint.ts
// ─────────────────────────────────────────────
//
// Tracks how far each language shard has progressed
// through its source parquet file, plus the next FAISS
// ID to hand out for that shard. This is what makes
// resume-after-crash possible without re-scanning from
// zero or double-counting IDs.
//
// Resume strategy: we don't have a native "seek to row N"
// on the DuckDB streaming query, so on resume we re-run
// the same stream from the top and skip (discard, no
// chunk/embed/index work) the first `rowsConsumed` rows
// before doing real work again. Re-reading+discarding
// rows from a local/FUSE parquet file is cheap relative
// to embedding, so this trades a bit of redundant I/O for
// a much simpler, more robust design than trying to make
// DuckDB's row_number() output resumable at an arbitrary
// offset.
// ─────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";

export interface LanguageCheckpointState {
    language: string;
    sourceFile: string;
    rowsConsumed: number;
    vectorsIndexed: number;
    nextFaissId: number;
    completed: boolean;
    updatedAt: string;
}

const STATE_FILE_NAME = "state.json";

export class Checkpoint {
    private state: LanguageCheckpointState;
    private readonly filePath: string;

    private constructor(filePath: string, state: LanguageCheckpointState) {
        this.filePath = filePath;
        this.state = state;
    }

    static async loadOrCreate(
        shardDir: string,
        language: string,
        sourceFile: string
    ): Promise<Checkpoint> {
        const filePath = path.join(shardDir, STATE_FILE_NAME);

        try {
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = JSON.parse(raw) as LanguageCheckpointState;

            // Source file changed (e.g. dataset regenerated) —
            // don't trust a stale offset against a different file.
            if (parsed.sourceFile !== sourceFile) {
                return new Checkpoint(filePath, {
                    language,
                    sourceFile,
                    rowsConsumed: 0,
                    vectorsIndexed: 0,
                    nextFaissId: 0,
                    completed: false,
                    updatedAt: new Date().toISOString(),
                });
            }

            return new Checkpoint(filePath, parsed);

        } catch {
            return new Checkpoint(filePath, {
                language,
                sourceFile,
                rowsConsumed: 0,
                vectorsIndexed: 0,
                nextFaissId: 0,
                completed: false,
                updatedAt: new Date().toISOString(),
            });
        }
    }

    get rowsConsumed(): number {
        return this.state.rowsConsumed;
    }

    get nextFaissId(): number {
        return this.state.nextFaissId;
    }

    get vectorsIndexed(): number {
        return this.state.vectorsIndexed;
    }

    get isCompleted(): boolean {
        return this.state.completed;
    }

    /**
     * Reserve a contiguous block of `count` FAISS IDs,
     * returning the first one. Caller assigns
     * [id, id+1, ..., id+count-1] to the batch it's about
     * to add.
     */
    reserveIds(count: number): number {
        const start = this.state.nextFaissId;
        this.state.nextFaissId += count;
        return start;
    }

    recordProgress(rowsConsumedDelta: number, vectorsIndexedDelta: number): void {
        this.state.rowsConsumed += rowsConsumedDelta;
        this.state.vectorsIndexed += vectorsIndexedDelta;
    }

    markCompleted(): void {
        this.state.completed = true;
    }

    /**
     * Atomic write: temp file + rename, same pattern as
     * VectorIndex.save(). Call this AFTER VectorIndex.save()
     * and MetadataStore.checkpoint() so that if we crash
     * between them, resuming re-processes a few extra rows
     * (safe — addBatch/addBatch use INSERT OR REPLACE and
     * FAISS IDs are still monotonic) rather than believing
     * we're further along than the index/metadata actually
     * are.
     */
    async persist(): Promise<void> {
        this.state.updatedAt = new Date().toISOString();

        const tmpPath = `${this.filePath}.tmp-${process.pid}`;
        await fs.writeFile(
            tmpPath,
            JSON.stringify(this.state, null, 2),
            "utf8"
        );
        await fs.rename(tmpPath, this.filePath);
    }
}
