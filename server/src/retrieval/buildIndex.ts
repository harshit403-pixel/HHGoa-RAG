import faiss from "faiss-node";
import { MistralAIEmbeddings } from "@langchain/mistralai";
import { readFile, writeFile } from "node:fs/promises";
import "dotenv/config";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const INPUT_FILE = "./data/hybrid-chunks.jsonl";

const INDEX_FILE = "./data/chunks.faiss";

const METADATA_FILE =
    "./data/chunks-metadata.json";

const MAX_CHUNKS = 1_000;

const BATCH_SIZE = 32;


// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface Chunk {
    chunk_id: string;
    parent_id: string;

    text: string;

    query_id: number;
    language: string;

    passage_index: number;
    is_selected: boolean;

    chunk_index: number;

    chunk_type: "whole" | "semantic";
}


// ─────────────────────────────────────────────
// Load chunks
// ─────────────────────────────────────────────

async function loadChunks(): Promise<Chunk[]> {

    const file =
        await readFile(
            INPUT_FILE,
            "utf8"
        );

    return file
        .split("\n")
        .filter(Boolean)
        .slice(0, MAX_CHUNKS)
        .map(
            line =>
                JSON.parse(line) as Chunk
        );
}


// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<void> {

    // ─────────────────────────────────────────
    // Check API key
    // ─────────────────────────────────────────

    if (!process.env.MISTRAL_API_KEY) {

        throw new Error(
            "MISTRAL_API_KEY is not set."
        );
    }


    // ─────────────────────────────────────────
    // Load chunks
    // ─────────────────────────────────────────

    console.log(
        "\nLoading chunks..."
    );

    const chunks =
        await loadChunks();

    console.log(
        `Loaded ${chunks.length} chunks`
    );


    if (chunks.length === 0) {

        throw new Error(
            "No chunks found."
        );
    }


    // ─────────────────────────────────────────
    // Create Mistral embedding client
    // ─────────────────────────────────────────

    const embeddings =
        new MistralAIEmbeddings({

            model:
                "mistral-embed",

            apiKey:
                process.env.MISTRAL_API_KEY,

            maxConcurrency:
                1,
        });


    // ─────────────────────────────────────────
    // Generate embeddings
    // ─────────────────────────────────────────

    const vectors: number[][] = [];

    console.log(
        `\nGenerating embeddings in batches of ${BATCH_SIZE}...\n`
    );

    const embeddingStart =
        performance.now();


    for (
        let startIndex = 0;
        startIndex < chunks.length;
        startIndex += BATCH_SIZE
    ) {

        const batch =
            chunks.slice(
                startIndex,
                startIndex + BATCH_SIZE
            );


        const texts =
            batch.map(
                chunk => chunk.text
            );


        const batchNumber =
            Math.floor(
                startIndex / BATCH_SIZE
            ) + 1;


        const totalBatches =
            Math.ceil(
                chunks.length /
                BATCH_SIZE
            );


        console.log(
            `Embedding batch ${batchNumber}/${totalBatches} ` +
            `(${batch.length} chunks)`
        );


        const batchVectors =
            await embeddings.embedDocuments(
                texts
            );


        if (
            batchVectors.length !==
            batch.length
        ) {

            throw new Error(
                `Embedding count mismatch. ` +
                `Expected ${batch.length}, ` +
                `got ${batchVectors.length}`
            );
        }


        vectors.push(
            ...batchVectors
        );
    }


    const embeddingElapsed =
        performance.now() -
        embeddingStart;


    console.log(
        `\nEmbedding complete in ${
            (embeddingElapsed / 1000).toFixed(2)
        } seconds`
    );


    // ─────────────────────────────────────────
    // Validate vector count
    // ─────────────────────────────────────────

    if (
        vectors.length !==
        chunks.length
    ) {

        throw new Error(
            `Vector/chunk mismatch: ` +
            `${vectors.length} vectors for ` +
            `${chunks.length} chunks`
        );
    }


    // ─────────────────────────────────────────
    // Determine dimensions
    // ─────────────────────────────────────────

    const firstVector =
        vectors[0];


    if (!firstVector) {

        throw new Error(
            "First vector is missing."
        );
    }


    const dimension =
        firstVector.length;


    if (dimension === 0) {

        throw new Error(
            "Embedding dimension is zero."
        );
    }


    console.log(
        `Embedding dimensions: ${dimension}`
    );


    // ─────────────────────────────────────────
    // Validate every vector
    // ─────────────────────────────────────────

    for (
        let i = 0;
        i < vectors.length;
        i++
    ) {

        const vector =
            vectors[i];


        if (!vector) {

            throw new Error(
                `Missing vector at index ${i}`
            );
        }


        if (
            vector.length !==
            dimension
        ) {

            throw new Error(
                `Vector ${i} has dimension ` +
                `${vector.length}, expected ` +
                `${dimension}`
            );
        }
    }


    // ─────────────────────────────────────────
    // Flatten vectors
    //
    // faiss-node expects number[]
    // ─────────────────────────────────────────

    const flatVectors: number[] = [];


    for (const vector of vectors) {

        flatVectors.push(
            ...vector
        );
    }


    const expectedValues =
        chunks.length *
        dimension;


    console.log(
        `Flat vector values: ${
            flatVectors.length
        }`
    );


    if (
        flatVectors.length !==
        expectedValues
    ) {

        throw new Error(
            `Flat vector size mismatch. ` +
            `Expected ${expectedValues}, ` +
            `got ${flatVectors.length}`
        );
    }


    // ─────────────────────────────────────────
    // Build FAISS index
    //
    // Inner Product is used for cosine
    // similarity when vectors are normalized.
    // ─────────────────────────────────────────

    console.log(
        "\nBuilding FAISS index..."
    );


    const index =
        new faiss.IndexFlatIP(
            dimension
        );


    index.add(
        flatVectors
    );


    const vectorCount =
        index.ntotal();


    console.log(
        `FAISS vectors: ${vectorCount}`
    );


    // ─────────────────────────────────────────
    // Validate FAISS count
    // ─────────────────────────────────────────

    if (
        vectorCount !==
        chunks.length
    ) {

        throw new Error(
            `FAISS count mismatch. ` +
            `Expected ${chunks.length}, ` +
            `got ${vectorCount}`
        );
    }


    // ─────────────────────────────────────────
    // Save FAISS index
    // ─────────────────────────────────────────

    console.log(
        "\nSaving FAISS index..."
    );


    index.write(
        INDEX_FILE
    );


    // ─────────────────────────────────────────
    // Create metadata
    //
    // FAISS result:
    //
    // vector 0
    //    ↓
    // metadata[0]
    //    ↓
    // chunk_id
    //    ↓
    // text
    // ─────────────────────────────────────────

    const metadata =
        chunks.map(
            (
                chunk,
                vectorId
            ) => ({

                vector_id:
                    vectorId,

                chunk_id:
                    chunk.chunk_id,

                parent_id:
                    chunk.parent_id,

                query_id:
                    chunk.query_id,

                passage_index:
                    chunk.passage_index,

                language:
                    chunk.language,

                is_selected:
                    chunk.is_selected,

                chunk_index:
                    chunk.chunk_index,

                chunk_type:
                    chunk.chunk_type,

                text:
                    chunk.text,
            })
        );


    await writeFile(
        METADATA_FILE,

        JSON.stringify(
            metadata,
            null,
            2
        ),

        "utf8"
    );


    // ─────────────────────────────────────────
    // Performance statistics
    // ─────────────────────────────────────────

    const seconds =
        embeddingElapsed /
        1000;


    const chunksPerSecond =
        chunks.length /
        seconds;


    // ─────────────────────────────────────────
    // Complete
    // ─────────────────────────────────────────

    console.log(
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        "FAISS INDEX COMPLETE"
    );

    console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        `Vectors: ${vectorCount}`
    );

    console.log(
        `Dimensions: ${dimension}`
    );

    console.log(
        `Chunks/sec: ${
            chunksPerSecond.toFixed(2)
        }`
    );

    console.log(
        `Index: ${INDEX_FILE}`
    );

    console.log(
        `Metadata: ${METADATA_FILE}`
    );

    console.log(
        "\n✅ Index successfully created."
    );
}


await main();