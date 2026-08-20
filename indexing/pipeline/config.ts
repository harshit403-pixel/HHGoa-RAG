// ─────────────────────────────────────────────
// indexing/config.ts
// ─────────────────────────────────────────────
//
// Single source of truth for every tunable in the
// indexing stage. Everything here is overridable via
// environment variable so the same code can be used
// to benchmark different embedding models / HNSW
// parameters without editing source.
//
// IMPORTANT: EMBEDDING_DIMENSION must match whatever
// EMBEDDING_MODEL actually outputs. We do NOT infer
// this automatically at startup because that would
// require loading the model before we know the
// dimension we're about to build an index for — get
// it wrong and every vector you've already indexed is
// stranded at the wrong width. verify-embedder.ts
// (see below) checks this for you before a real run.
// ─────────────────────────────────────────────

import "dotenv/config";

function envString(name: string, fallback: string): string {
    return process.env[name]?.trim() || fallback;
}

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

// ─────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────

// Source data — read-only, streamed, never copied.
export const TRAIN_DIR = envString("TRAIN_DIR", "/data/hfData/train");

// Destination for indexes. Kept in a distinct subtree
// (hhgoa/indexes) from the source data (hfData/train) so
// a recursive cleanup of one never touches the other —
// they don't need to be on separate physical disks, just
// separate paths that are never crossed by writes.
export const INDEX_ROOT = envString("INDEX_ROOT", "/data/hhgoa/indexes");

// ─────────────────────────────────────────────
// Embedding
// ─────────────────────────────────────────────

// Which embedder implementation to use. "local" runs
// an ONNX model in-process via @xenova/transformers
// (CPU, or GPU if onnxruntime-node's CUDA EP is
// available). "http" calls an external embedding
// server (Text-Embeddings-Inference, vLLM, an
// OpenAI-compatible endpoint, etc.) — recommended once
// you have a GPU box, since it decouples embedding
// throughput from the ingestion process entirely and
// lets you scale it independently / run multiple
// ingestion workers against one GPU server.
export const EMBEDDING_PROVIDER = envString("EMBEDDING_PROVIDER", "local") as
    | "local"
    | "http";

// Model identifier. For "local" this is a HuggingFace
// repo id resolvable by @xenova/transformers (must have
// ONNX weights, e.g. "Xenova/multilingual-e5-large" —
// a reasonable default for this dataset since it's
// multilingual and MSMARCO-style). For "http" this is
// passed through as the `model` field in requests, if
// your server expects one.
export const EMBEDDING_MODEL = envString(
    "EMBEDDING_MODEL",
    "Xenova/multilingual-e5-large",
);

// MUST match the model's actual output width. See
// verify-embedder.ts — run it once per model change,
// don't hand-edit this blind.
export const EMBEDDING_DIMENSION = envInt("EMBEDDING_DIMENSION", 1024);

// How many chunk texts go into one embed() call. Larger
// batches → better throughput (especially on GPU) at
// the cost of more peak memory per batch and higher
// latency-to-first-result. This is NOT the same as
// MAX_PENDING_CHUNKS below.
export const EMBEDDING_BATCH_SIZE = envInt("EMBEDDING_BATCH_SIZE", 32);

// Only used when EMBEDDING_PROVIDER === "http".
export const EMBEDDING_HTTP_URL = envString(
    "EMBEDDING_HTTP_URL",
    "http://localhost:8080/embed",
);

// ─────────────────────────────────────────────
// Vector index
// ─────────────────────────────────────────────

// "hnsw" = production approximate index (fast, sublinear
// query time, small recall loss).
// "flat" = exact brute-force index. O(n) per query. Only
// meant for recall evaluation / correctness testing on
// a subset — do not run this over the full corpus.
export const INDEX_TYPE = envString("INDEX_TYPE", "hnsw") as "hnsw" | "flat";

// HNSW graph degree. Higher M → better recall & more
// memory (~M * 2 * 4 bytes of graph overhead per vector,
// on top of the raw vectors) & slower inserts. 16 is the
// standard default; 32-64 for higher-recall workloads.
export const HNSW_M = envInt("HNSW_M", 32);

// Search-list size used only while building the graph.
// Higher → better graph quality & slower indexing. Does
// NOT affect query time. 40-200 is typical; go higher for
// static one-time-build corpora like this one, since
// indexing time is a one-off cost, but query quality
// depends on it forever.
export const HNSW_EF_CONSTRUCTION = envInt("HNSW_EF_CONSTRUCTION", 200);

// Search-list size used at query time. Higher → better
// recall, higher latency, roughly linear in efSearch.
// This is the knob you tune live per query without
// rebuilding anything — exposed again in search()'s
// options and swept explicitly in the benchmark.
export const HNSW_EF_SEARCH = envInt("HNSW_EF_SEARCH", 64);

// ─────────────────────────────────────────────
// Memory / concurrency control
// ─────────────────────────────────────────────

// How many language parquet files are streamed/embedded/
// indexed concurrently. Bounds both FUSE mount I/O
// concurrency and peak embedding+index memory (each
// concurrent file holds at most MAX_PENDING_CHUNKS chunks
// in flight — see below).
export const FILE_CONCURRENCY = envInt("FILE_CONCURRENCY", 1);

// Hard cap on chunks buffered (post-chunking, pre-embedding)
// per file before we're forced to flush an embed+index
// cycle even if EMBEDDING_BATCH_SIZE hasn't been reached.
// This is the real memory bound, independent of how fast
// chunking vs. embedding runs.
export const MAX_PENDING_CHUNKS = envInt("MAX_PENDING_CHUNKS", 2_000);

// Hard cap on embedding batches allowed to be in flight
// (embedded but not yet added to the index) per file. With
// an HTTP embedder in particular, embedding often
// outpaces FAISS insertion; this prevents an unbounded
// queue of Float32Array batches from piling up in memory
// while waiting for the (single-threaded) FAISS add() to
// catch up.
export const MAX_PENDING_EMBEDDING_BATCHES = envInt(
    "MAX_PENDING_EMBEDDING_BATCHES",
    1,
);

// ─────────────────────────────────────────────
// Checkpointing
// ─────────────────────────────────────────────

// Persist index + metadata + processing state after every
// N vectors added, per language shard. Lower = safer
// (less work lost on crash) but more I/O overhead from
// repeated index serialization; higher = faster overall
// but more re-work on crash. For a corpus expected to run
// for hours, checkpointing every 50k-200k vectors is a
// reasonable balance — each checkpoint's cost is
// dominated by re-serializing the whole HNSW graph, which
// grows with total index size, so shrink this as the
// index grows if checkpoint time itself becomes a
// bottleneck.
export const CHECKPOINT_EVERY_N_VECTORS = envInt(
    "CHECKPOINT_EVERY_N_VECTORS",
    100_000,
);

// ─────────────────────────────────────────────
// Progress reporting
// ─────────────────────────────────────────────

export const PROGRESS_EVERY_N_PASSAGES = envInt(
    "PROGRESS_EVERY_N_PASSAGES",
    100,
);
