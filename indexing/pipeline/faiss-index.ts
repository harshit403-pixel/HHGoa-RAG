// ─────────────────────────────────────────────
// indexing/faiss-index.ts
// ─────────────────────────────────────────────
//
// Thin, typed wrapper around faiss-napi. Isolates every
// FAISS-specific call in one place so index-pipeline.ts
// and search.ts never touch the native binding directly —
// swapping HNSW/Flat, or swapping faiss-napi for a
// different binding entirely, only touches this file.
//
// Uses IndexIDMap2 over the base index so every vector
// keeps a STABLE external ID (our own monotonic counter,
// tracked in checkpoint.ts) rather than FAISS's implicit
// insertion-order label. That matters for two reasons:
//   1. On resume after a crash, re-adding the same vector
//      twice must not create a duplicate under a new label.
//   2. The metadata store keys off this same ID, so the
//      mapping vector -> chunk survives index rebuilds.
// ─────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";

import {
    EMBEDDING_DIMENSION,
    HNSW_EF_CONSTRUCTION,
    HNSW_EF_SEARCH,
    HNSW_M,
    INDEX_TYPE,
} from "./config.ts";

// faiss-napi ships CJS with its own .d.ts; import via
// namespace import to keep this file strict-mode clean
// without needing to hand-roll types for the whole lib.
import * as faiss from "faiss-napi";

export interface IndexSearchResult {
    ids: bigint[];
    distances: number[];
}

export interface VectorIndexOptions {
    dimension?: number;
    indexType?: "hnsw" | "flat";
    hnswM?: number;
    hnswEfConstruction?: number;
    hnswEfSearch?: number;
}

// ─────────────────────────────────────────────
// VectorIndex
// ─────────────────────────────────────────────

export class VectorIndex {
    private readonly dimension: number;
    private readonly indexType: "hnsw" | "flat";
    private readonly hnswM: number;
    private readonly hnswEfConstruction: number;
    private index: faiss.IndexIDMap2;

    /**
     * currentEfSearch tracks what's currently applied to
     * the live index object, so setEfSearch() is a no-op
     * when called redundantly (e.g. once per benchmark
     * iteration).
     */
    private currentEfSearch: number;

    /**
     * Private on purpose — external callers use `new VectorIndex(...)`
     * for a fresh index, or `VectorIndex.load(...)` to restore one
     * from disk. Both funnel through here; `preloadedIndex` lets
     * `load()` skip building a fresh graph.
     */
    private constructor(
        options: VectorIndexOptions,
        preloadedIndex: faiss.IndexIDMap2 | null
    ) {
        this.dimension = options.dimension ?? EMBEDDING_DIMENSION;
        this.indexType = options.indexType ?? INDEX_TYPE;
        this.hnswM = options.hnswM ?? HNSW_M;
        this.hnswEfConstruction =
            options.hnswEfConstruction ?? HNSW_EF_CONSTRUCTION;
        this.currentEfSearch = options.hnswEfSearch ?? HNSW_EF_SEARCH;

        this.index = preloadedIndex ?? this.buildBaseIndex();
    }

    static create(options: VectorIndexOptions = {}): VectorIndex {
        return new VectorIndex(options, null);
    }

    private buildBaseIndex(): faiss.IndexIDMap2 {
        if (this.indexType === "flat") {
            // Exact search baseline — recall/correctness
            // evaluation only. O(n) per query, so keep this
            // to subsets, never the full corpus.
            const flat = new faiss.IndexFlatL2(this.dimension);
            return flat.toIDMap2();
        }

        // Production path: HNSW, built via factory string so
        // efConstruction is applied before any vectors are
        // added (efConstruction only affects graph quality
        // at insertion time, not after).
        //
        // Tradeoffs, for reference (also in config.ts):
        //   - M: graph connectivity. Higher = better recall,
        //     more memory (~M*2*4 bytes/vector graph overhead),
        //     slower inserts.
        //   - efConstruction: search depth while building.
        //     Higher = better final graph quality, slower
        //     one-time indexing. Doesn't affect query latency.
        //   - efSearch: search depth while querying. Higher =
        //     better recall, higher per-query latency. This is
        //     the only one of the three that's cheap to change
        //     after the fact (see setEfSearch below) — tune it
        //     live, don't rebuild the index for it.
        const factoryString = `HNSW${this.hnswM},Flat`;

        const hnsw = faiss.Index.fromFactory(
            this.dimension,
            factoryString,
            faiss.MetricType.METRIC_L2
        ) as faiss.IndexHNSW;

        hnsw.hnsw.efConstruction = this.hnswEfConstruction;
        hnsw.hnsw.efSearch = this.currentEfSearch;

        return hnsw.toIDMap2();
    }

    get ntotal(): number {
        return this.index.ntotal;
    }

    /**
     * Add a batch of vectors under explicit external IDs.
     * `vectors` is a flat row-major Float32Array of length
     * ids.length * dimension — the same layout Embedder.embed()
     * returns, so callers pass it straight through with no
     * copy or reshape.
     */
    addBatch(ids: bigint[], vectors: Float32Array): void {
        if (ids.length === 0) return;

        const expectedLength = ids.length * this.dimension;
        if (vectors.length !== expectedLength) {
            throw new Error(
                `Vector batch length ${vectors.length} does not match ` +
                `ids.length (${ids.length}) * dimension (${this.dimension})`
            );
        }

        this.index.addWithIds(Array.from(vectors), ids);
    }

    /**
     * Query-time efSearch is mutable on a live HNSW index
     * without rebuilding — this is the parameter the
     * benchmark sweeps.
     */
    setEfSearch(efSearch: number): void {
        if (this.indexType !== "hnsw") return;
        if (efSearch === this.currentEfSearch) return;

        // faiss-napi exposes the underlying HNSW struct through
        // IndexIDMap2's wrapped index; if a future version
        // changes this path, this is the one place to fix it.
        const inner = (this.index as unknown as { index: faiss.IndexHNSW }).index;
        inner.hnsw.efSearch = efSearch;
        this.currentEfSearch = efSearch;
    }

    search(vector: Float32Array, topK: number): IndexSearchResult {
        const result = this.index.search(Array.from(vector), topK);
        return {
            ids: result.labels as bigint[],
            distances: result.distances,
        };
    }

    /**
     * Atomic save: write to a temp file in the same directory,
     * then rename over the target. Rename is atomic on the
     * same filesystem (POSIX), so a crash mid-write never
     * leaves a corrupt index.faiss in place — worst case, a
     * stray .tmp file that the next run overwrites.
     */
    async save(filePath: string): Promise<void> {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        const tmpPath = `${filePath}.tmp-${process.pid}`;
        const buffer = this.index.toBuffer();

        await fs.writeFile(tmpPath, buffer);
        await fs.rename(tmpPath, filePath);
    }

    static async load(
        filePath: string,
        options: VectorIndexOptions = {}
    ): Promise<VectorIndex> {
        const buffer = await fs.readFile(filePath);
        const restored = faiss.Index.fromBuffer(buffer) as faiss.IndexIDMap2;

        return new VectorIndex(options, restored);
    }

    static async exists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
