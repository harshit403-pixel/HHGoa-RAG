// ─────────────────────────────────────────────
// indexing/search.ts
// ─────────────────────────────────────────────
//
// Query-time API. Loads one language shard (index +
// metadata store) and exposes search(). Kept stateful
// (a small class) rather than a bare function so a
// long-lived query server can load the shard once and
// reuse it across many requests instead of re-reading
// index.faiss from disk per query.
// ─────────────────────────────────────────────

import path from "node:path";

import { HNSW_EF_SEARCH, INDEX_ROOT } from "./config.ts";
import { createEmbedder, type Embedder } from "./embedder.ts";
import { VectorIndex } from "./faiss-index.ts";
import { MetadataStore } from "./metadata-store.ts";

export interface SearchResult {
    score: number;
    chunk_id: string;
    parent_id: string;
    text: string;
    language: string;
    query_id: number;
    passage_index: number;
    chunk_index: number;
    chunk_type: "whole" | "semantic";
}

export interface SearchOptions {
    efSearch?: number;
}

export class LanguageSearcher {
    private constructor(
        private readonly language: string,
        private readonly index: VectorIndex,
        private readonly metadata: MetadataStore,
        private readonly embedder: Embedder
    ) {}

    static async open(
        language: string,
        embedder: Embedder = createEmbedder()
    ): Promise<LanguageSearcher> {
        const dir = path.join(INDEX_ROOT, language);
        const indexFile = path.join(dir, "index.faiss");

        if (!(await VectorIndex.exists(indexFile))) {
            throw new Error(
                `No index found for language "${language}" at ${indexFile}. ` +
                `Has indexing run for this language yet?`
            );
        }

        const index = await VectorIndex.load(indexFile);
        const metadata = await MetadataStore.open(
            path.join(dir, "metadata.db")
        );

        return new LanguageSearcher(language, index, metadata, embedder);
    }

    async search(
        query: string,
        topK: number,
        options: SearchOptions = {}
    ): Promise<SearchResult[]> {
        const queryVector = await this.embedder.embed([query]);
        return this.searchWithVector(queryVector, topK, options);
    }

    /**
     * Search using an already-computed query vector, skipping
     * the embed step. Used internally by search(), and exposed
     * directly so callers that want to time embedding and FAISS
     * search separately (e.g. benchmark/retrieval.ts) can do so
     * without this module needing any benchmark-specific code.
     */
    searchWithVector(
        queryVector: Float32Array,
        topK: number,
        options: SearchOptions = {}
    ): SearchResult[] {

        if (options.efSearch !== undefined) {
            this.index.setEfSearch(options.efSearch);
        } else {
            this.index.setEfSearch(HNSW_EF_SEARCH);
        }

        const { ids, distances } = this.index.search(queryVector, topK);

        const results: SearchResult[] = [];

        for (let i = 0; i < ids.length; i++) {
            const faissId = Number(ids[i]);

            // faiss-napi pads short result lists with -1 labels
            // when the index has fewer than topK vectors.
            if (faissId < 0) continue;

            const meta = this.metadata.getByFaissId(faissId);
            if (!meta) continue;

            results.push({
                // L2 distance -> similarity-style score: smaller
                // distance is better, so we negate for a
                // "higher is better" convention. Callers that
                // want raw distance can use `-score`.
                score: -distances[i],
                chunk_id: meta.chunk_id,
                parent_id: meta.parent_id,
                text: meta.text,
                language: meta.language,
                query_id: meta.query_id,
                passage_index: meta.passage_index,
                chunk_index: meta.chunk_index,
                chunk_type: meta.chunk_type,
            });
        }

        return results;
    }

    close(): void {
        this.metadata.close();
    }
}

// ─────────────────────────────────────────────
// Convenience one-shot function, matching the interface
// requested in the spec. Prefer LanguageSearcher directly
// for anything that issues more than one query — this
// re-opens the index from disk every call.
// ─────────────────────────────────────────────

export async function search(
    query: string,
    topK: number,
    language: string
): Promise<SearchResult[]> {
    const searcher = await LanguageSearcher.open(language);
    try {
        return await searcher.search(query, topK);
    } finally {
        searcher.close();
    }
}
