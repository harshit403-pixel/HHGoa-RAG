// ─────────────────────────────────────────────
// indexing/embedder.ts
// ─────────────────────────────────────────────
//
// Embedder abstraction. Two implementations are
// provided; both satisfy the same interface so the
// rest of the pipeline never knows which one it's
// talking to. Selected via EMBEDDING_PROVIDER.
// ─────────────────────────────────────────────

import {
    EMBEDDING_DIMENSION,
    EMBEDDING_HTTP_URL,
    EMBEDDING_MODEL,
    EMBEDDING_PROVIDER,
} from "./config.ts";
import logger from "./logger.js";

// ─────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────
//
// embed() takes N texts and returns a single flat
// Float32Array of length N * dimension (row-major:
// vector i occupies [i*dimension, (i+1)*dimension)).
// This flat layout is what faiss-napi's add()/search()
// expect natively, so no reshaping is needed between
// embedder output and index input.
// ─────────────────────────────────────────────

export interface Embedder {
    readonly dimension: number;
    readonly model: string;
    embed(texts: string[]): Promise<Float32Array>;
}

// ─────────────────────────────────────────────
// Local embedder (@xenova/transformers, ONNX runtime)
// ─────────────────────────────────────────────
//
// Runs entirely in-process. Uses onnxruntime-node under
// the hood — CPU by default; if onnxruntime-node's CUDA
// execution provider is installed AND a compatible GPU/
// CUDA/cuDNN stack is present, it will use it, but this
// is not something we can detect or force generically
// here (see the writeup on GPU support). Good for
// getting started without standing up a separate
// service; not the best throughput option at hundreds
// of millions of chunks.
// ─────────────────────────────────────────────

// Lazily typed to avoid a hard dependency at type-check
// time if the package isn't installed yet — resolved
// dynamically in initialize().
type FeatureExtractionPipeline = (
    texts: string[],
    options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

export class LocalTransformersEmbedder implements Embedder {
    readonly dimension: number;
    readonly model: string;

    private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

    constructor(model: string = EMBEDDING_MODEL, dimension: number = EMBEDDING_DIMENSION) {
        this.model = model;
        this.dimension = dimension;
    }

    private async getPipeline(): Promise<FeatureExtractionPipeline> {
        if (!this.pipelinePromise) {
            this.pipelinePromise = (async () => {
                // Dynamic import: @xenova/transformers is an
                // optional dependency of this module — only
                // required when EMBEDDING_PROVIDER === "local".
                const { pipeline } = await import("@xenova/transformers");
                const extractor = await pipeline(
                    "feature-extraction",
                    this.model
                );
                return extractor as unknown as FeatureExtractionPipeline;
            })();
        }
        return this.pipelinePromise;
    }

    async embed(texts: string[]): Promise<Float32Array> {
        if (texts.length === 0) {
            return new Float32Array(0);
        }

        const extractor = await this.getPipeline();

        const output = await extractor(texts, {
            pooling: "mean",
            normalize: true,
        });

        const actualDim = output.dims[output.dims.length - 1];

        if (actualDim !== this.dimension) {
            throw new Error(
                `Embedder "${this.model}" produced dimension ${actualDim}, ` +
                `but EMBEDDING_DIMENSION is configured as ${this.dimension}. ` +
                `Run indexing/verify-embedder.ts and update EMBEDDING_DIMENSION.`
            );
        }

        return output.data;
    }
}

// ─────────────────────────────────────────────
// HTTP embedder
// ─────────────────────────────────────────────
//
// Calls an external embedding server. Compatible out of
// the box with HuggingFace Text-Embeddings-Inference's
// `/embed` endpoint (`{"inputs": string[]}` ->
// `number[][]`). If your server uses a different
// contract (e.g. OpenAI's `/v1/embeddings`), adjust
// buildRequestBody/parseResponse — they're isolated on
// purpose.
//
// Recommended once you move embedding to a GPU box: this
// decouples ingestion (CPU-bound: parquet read, chunk,
// index insert) from embedding (GPU-bound), and lets you
// run several ingestion workers against one shared
// embedding server instead of loading the model once per
// worker process.
// ─────────────────────────────────────────────

export class HttpEmbedder implements Embedder {
    readonly dimension: number;
    readonly model: string;

    constructor(
        private readonly url: string = EMBEDDING_HTTP_URL,
        model: string = EMBEDDING_MODEL,
        dimension: number = EMBEDDING_DIMENSION
    ) {
        this.model = model;
        this.dimension = dimension;
    }

    async embed(texts: string[]): Promise<Float32Array> {
        if (texts.length === 0) {
            return new Float32Array(0);
        }

        const response = await fetch(this.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                inputs: texts,
                model: this.model,
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(
                `Embedding request failed: ${response.status} ${response.statusText} ${body}`
            );
        }

        const parsed = (await response.json()) as number[][];

        const flat = new Float32Array(texts.length * this.dimension);

        for (let i = 0; i < parsed.length; i++) {
            const vec = parsed[i];

            if (!vec || vec.length !== this.dimension) {
                throw new Error(
                    `Embedding server returned vector of length ${vec?.length ?? "undefined"} ` +
                    `at index ${i}, expected ${this.dimension}.`
                );
            }

            flat.set(vec, i * this.dimension);
        }

        return flat;
    }
}

// ─────────────────────────────────────────────
// Mistral AI embedder
// ─────────────────────────────────────────────
//
// Calls Mistral AI's embedding API. Rotates through up to 4
// API keys if errors or rate limits are hit. If all keys fail,
// sleeps for 3 minutes before retrying to respect quotas/limits.
// ─────────────────────────────────────────────

// Global API Key Coordinator to prevent concurrent requests on the same key
// and enforce a strict 2-second cooldown between requests per key.
class MistralKeyCoordinator {
    private static lastUsedTime: number[] = [];
    private static keyLocks: boolean[] = [];
    private static apiKeys: string[] = [];

    static init(keys: string[]) {
        if (this.apiKeys.length === 0) {
            this.apiKeys = keys;
            this.lastUsedTime = new Array(keys.length).fill(0);
            this.keyLocks = new Array(keys.length).fill(false);
        }
    }

    static async acquireKey(startingIndex: number): Promise<{ apiKey: string; index: number }> {
        const totalKeys = this.apiKeys.length;
        let index = startingIndex % totalKeys;

        while (true) {
            let foundIndex = -1;
            for (let i = 0; i < totalKeys; i++) {
                const checkIndex = (index + i) % totalKeys;
                const lastUsed = this.lastUsedTime[checkIndex] ?? 0;
                const elapsed = Date.now() - lastUsed;
                if (!this.keyLocks[checkIndex] && elapsed >= 2000) {
                    foundIndex = checkIndex;
                    break;
                }
            }

            if (foundIndex !== -1) {
                this.keyLocks[foundIndex] = true;
                this.lastUsedTime[foundIndex] = Date.now();
                const key = this.apiKeys[foundIndex];
                if (key) {
                    return { apiKey: key, index: foundIndex };
                }
            }

            // Check again in 100ms
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    static releaseKey(index: number, success: boolean) {
        this.keyLocks[index] = false;
        this.lastUsedTime[index] = Date.now(); // Cooldown starts from the release point
    }
}

export class MistralEmbedder implements Embedder {
    readonly dimension = 1024;
    readonly model = "mistral-embed";
    private readonly apiKeys: string[];
    private currentKeyIndex = 0;

    constructor() {
        const keys: string[] = [];
        if (process.env.MISTRAL_API_KEY) {
            keys.push(process.env.MISTRAL_API_KEY.trim());
        }

        let keyIndex = 2;
        while (true) {
            const key = process.env[`MISTRAL_API_KEY${keyIndex}`];
            if (!key) break;
            keys.push(key.trim());
            keyIndex++;
        }

        this.apiKeys = keys.filter(Boolean);

        if (this.apiKeys.length === 0) {
            logger.error("MistralEmbedder initialization failed: No API keys configured");
            throw new Error(
                "MistralEmbedder requires at least one API key. " +
                "Please configure MISTRAL_API_KEY, MISTRAL_API_KEY2, MISTRAL_API_KEY3, etc."
            );
        }

        // Initialize the global coordinator with these keys
        MistralKeyCoordinator.init(this.apiKeys);

        // Start at a random key index to distribute load across API keys when multiple workers run
        this.currentKeyIndex = Math.floor(Math.random() * this.apiKeys.length);
        logger.info(
            { totalKeys: this.apiKeys.length, startingKeyIndex: this.currentKeyIndex },
            "MistralEmbedder successfully initialized with dynamic key discovery"
        );
    }

    async embed(texts: string[]): Promise<Float32Array> {
        if (texts.length === 0) {
            return new Float32Array(0);
        }

        let attempts = 0;
        const totalKeys = this.apiKeys.length;

        logger.info({ batchSize: texts.length }, "Sending batch of texts to Mistral API");

        while (true) {
            // Acquire a key that is guaranteed to be unlocked and cooled down
            const { apiKey, index: keyIndex } = await MistralKeyCoordinator.acquireKey(this.currentKeyIndex);

            try {
                const response = await fetch("https://api.mistral.ai/v1/embeddings", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: this.model,
                        input: texts,
                    }),
                });

                if (!response.ok) {
                    const errorBody = await response.text().catch(() => "");
                    throw new Error(
                        `HTTP error ${response.status}: ${response.statusText} - ${errorBody}`
                    );
                }

                interface MistralEmbeddingResponse {
                    data: {
                        embedding: number[];
                        index: number;
                    }[];
                }

                const result = (await response.json()) as MistralEmbeddingResponse;
                const flat = new Float32Array(texts.length * this.dimension);

                for (const item of result.data) {
                    flat.set(item.embedding, item.index * this.dimension);
                }

                logger.info(
                    { keyIndex, vectorCount: result.data.length },
                    "Successfully embedded batch with Mistral API"
                );

                // Release key and mark it successful
                MistralKeyCoordinator.releaseKey(keyIndex, true);
                this.currentKeyIndex = keyIndex;

                return flat;

            } catch (error) {
                // Release key lock even on failure so other workers can try it
                MistralKeyCoordinator.releaseKey(keyIndex, false);

                const errMsg = error instanceof Error ? error.message : String(error);
                logger.warn(
                    { keyIndex, error: errMsg },
                    "Mistral API request failed"
                );

                attempts++;
                // Switch starting index to the next key
                this.currentKeyIndex = (keyIndex + 1) % totalKeys;

                // Wait 5 seconds before trying the next key to avoid immediate cascading rate limits
                logger.warn("Sleeping for 5 seconds before trying the next key/retry...");
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // If we tried all keys and failed
                if (attempts >= totalKeys) {
                    logger.error(
                        { attempts, totalKeys },
                        "All Mistral API keys failed. Sleeping for 3 minutes before retrying..."
                    );
                    // Wait for 3 minutes (180 seconds)
                    await new Promise((resolve) => setTimeout(resolve, 180000));
                    attempts = 0; // Reset attempts to try all keys again
                } else {
                    logger.info({ nextKeyIndex: this.currentKeyIndex }, "Rotating to next API key");
                }
            }
        }
    }
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export function createEmbedder(): Embedder {
    if (
        process.env.MISTRAL_API_KEY ||
        process.env.MISTRAL_API_KEY2 ||
        process.env.MISTRAL_API_KEY3 ||
        process.env.MISTRAL_API_KEY4
    ) {
        return new MistralEmbedder();
    }
    if (EMBEDDING_PROVIDER === "http") {
        return new HttpEmbedder();
    }
    return new LocalTransformersEmbedder();
}
