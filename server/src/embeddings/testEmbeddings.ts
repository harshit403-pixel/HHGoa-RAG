import { MistralAIEmbeddings } from "@langchain/mistralai";
import { readFile } from "node:fs/promises";
import "dotenv/config"

const INPUT_FILE = "./data/hybrid-chunks.jsonl";
const MAX_CHUNKS = 1_000;

// Start conservatively.
// We can increase this after measuring.
const BATCH_SIZE = 32;

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


async function main(): Promise<void> {

    if (!process.env.MISTRAL_API_KEY) {
        throw new Error(
            "MISTRAL_API_KEY is not set."
        );
    }


    const chunks =
        await loadChunks();


    console.log(
        `Loaded ${chunks.length} chunks`
    );


    const embeddings =
        new MistralAIEmbeddings({

            model: "mistral-embed",

            apiKey:
                process.env.MISTRAL_API_KEY,

            maxConcurrency: 1,
        });


    const allVectors: number[][] = [];


    const start =
        performance.now();


    console.log(
        `\nEmbedding in batches of ${BATCH_SIZE}...\n`
    );


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
                chunks.length / BATCH_SIZE
            );


        console.log(
            `Batch ${batchNumber}/${totalBatches} ` +
            `(${batch.length} chunks)`
        );


        const vectors =
            await embeddings.embedDocuments(
                texts
            );


        allVectors.push(
            ...vectors
        );
    }


    const elapsed =
        performance.now() - start;


    console.log(
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        "EMBEDDING TEST COMPLETE"
    );

    console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );


    console.log(
        "Chunks:",
        allVectors.length
    );


    console.log(
        "Dimensions:",
        allVectors[0]?.length ?? 0
    );


    console.log(
        "Time:",
        `${(elapsed / 1000).toFixed(2)} seconds`
    );


    const seconds =
        elapsed / 1000;


    const chunksPerSecond =
        allVectors.length /
        seconds;


    console.log(
        "Chunks/sec:",
        chunksPerSecond.toFixed(2)
    );


    console.log(
        "Estimated 100k time:",
        `${(
            100_000 /
            chunksPerSecond /
            60
        ).toFixed(2)} minutes`
    );


    console.log(
        "\nFirst vector:"
    );

    console.log(
        allVectors[0]?.slice(0, 10)
    );
}


await main();