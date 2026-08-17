import faiss from "faiss-node";
import { MistralAIEmbeddings } from "@langchain/mistralai";
import { readFile } from "node:fs/promises";
import "dotenv/config";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const INDEX_FILE = "./data/chunks.faiss";
const METADATA_FILE = "./data/chunks-metadata.json";

const TOP_K = 5;


// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface ChunkMetadata {
    vector_id: number;

    chunk_id: string;
    parent_id: string;

    query_id: number;
    passage_index: number;

    language: string;

    is_selected: boolean;

    chunk_index: number;

    chunk_type: "whole" | "semantic";

    text: string;
}


// ─────────────────────────────────────────────
// Load metadata
// ─────────────────────────────────────────────

async function loadMetadata(): Promise<ChunkMetadata[]> {

    const file = await readFile(
        METADATA_FILE,
        "utf8"
    );

    return JSON.parse(file) as ChunkMetadata[];
}


// ─────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────

async function search(
    query: string
): Promise<void> {

    if (!process.env.MISTRAL_API_KEY) {
        throw new Error(
            "MISTRAL_API_KEY is not set."
        );
    }


    // ─────────────────────────────────────────
    // 1. Load FAISS
    // ─────────────────────────────────────────

    console.time("FAISS load");

    const index =
        faiss.IndexFlatIP.read(
            INDEX_FILE
        );

    console.timeEnd("FAISS load");


    const vectorCount =
        index.ntotal();

    console.log(
        `Vectors in index: ${vectorCount}`
    );


    // ─────────────────────────────────────────
    // 2. Load metadata
    // ─────────────────────────────────────────

    console.time("Metadata load");

    const metadata =
        await loadMetadata();

    console.timeEnd("Metadata load");


    if (
        metadata.length !==
        vectorCount
    ) {
        throw new Error(
            `Metadata/index mismatch. ` +
            `Index: ${vectorCount}, ` +
            `Metadata: ${metadata.length}`
        );
    }


    // ─────────────────────────────────────────
    // 3. Create embedding client
    // ─────────────────────────────────────────

    console.time("Embedding client creation");

    const embeddings =
        new MistralAIEmbeddings({
            model: "mistral-embed",

            apiKey:
                process.env.MISTRAL_API_KEY,

            maxConcurrency: 1,
        });

    console.timeEnd(
        "Embedding client creation"
    );


    // ─────────────────────────────────────────
    // 4. Embed query
    // ─────────────────────────────────────────

    console.time("Mistral embedding");

    const queryVector =
        await embeddings.embedQuery(
            query
        );

    console.timeEnd(
        "Mistral embedding"
    );


    if (
        queryVector.length === 0
    ) {
        throw new Error(
            "Query embedding is empty."
        );
    }


    console.log(
        `Embedding dimensions: ${
            queryVector.length
        }`
    );


    // ─────────────────────────────────────────
    // 5. FAISS search
    // ─────────────────────────────────────────

    const k =
        Math.min(
            TOP_K,
            vectorCount
        );


    console.time("FAISS search");

    const result =
        index.search(
            queryVector,
            k
        );

    console.timeEnd("FAISS search");


    // ─────────────────────────────────────────
    // 6. Metadata lookup
    // ─────────────────────────────────────────

    console.time(
        "Metadata result lookup"
    );

    const results = [];

    for (
        let i = 0;
        i < k;
        i++
    ) {

        const vectorId =
            result.labels[i];

        const score =
            result.distances[i];


        if (
            vectorId === undefined
        ) {
            continue;
        }


        const chunk =
            metadata[vectorId];


        if (!chunk) {
            continue;
        }


        results.push({
            rank: i + 1,
            score,
            chunk,
        });
    }

    console.timeEnd(
        "Metadata result lookup"
    );


    // ─────────────────────────────────────────
    // 7. Print results
    // ─────────────────────────────────────────

    console.log(
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        "SEARCH RESULTS"
    );

    console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        `Query: ${query}`
    );

    console.log(
        `Top K: ${k}`
    );


    for (const resultItem of results) {

        const {
            rank,
            score,
            chunk,
        } = resultItem;


        console.log(
            `\n──────── RESULT ${rank} ────────`
        );

        console.log(
            `Score: ${score?.toFixed(4)}`
        );

        console.log(
            `Chunk ID: ${chunk.chunk_id}`
        );

        console.log(
            `Parent: ${chunk.parent_id}`
        );

        console.log(
            `Language: ${chunk.language}`
        );

        console.log(
            `Selected: ${chunk.is_selected}`
        );

        console.log(
            `Type: ${chunk.chunk_type}`
        );

        console.log(
            `\n${chunk.text}`
        );
    }
}


// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

const query =
    process.argv
        .slice(2)
        .join(" ")
        .trim();


if (!query) {

    console.error(
        'Usage: npx tsx src/retrieval/search.ts "your query"'
    );

    process.exit(1);
}


await search(query);