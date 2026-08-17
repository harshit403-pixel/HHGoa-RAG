import { DuckDBInstance } from "@duckdb/node-api";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { appendFile, writeFile } from "node:fs/promises";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const INPUT_FILE = "./data/hintrain.parquet";
const OUTPUT_FILE = "./data/hybrid-chunks.jsonl";

const MAX_RECORDS = 10_000;

const SHORT_PASSAGE_CHARS = 900;

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 100;


// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface PassageRow {
    query_id: number;
    target_lang: string;
    passage_index: number;
    passage: string;
    is_selected: boolean;
}

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
// LangChain splitter
// ─────────────────────────────────────────────
//
// Order matters.
//
// LangChain will prefer:
//
// paragraph
//    ↓
// newline
//    ↓
// Hindi danda
//    ↓
// double danda
//    ↓
// English punctuation
//    ↓
// spaces
//    ↓
// characters
//
// This gives us hierarchical splitting rather
// than blindly cutting every N characters.
// ─────────────────────────────────────────────

const splitter =
    new RecursiveCharacterTextSplitter({

        chunkSize: CHUNK_SIZE,

        chunkOverlap: CHUNK_OVERLAP,

        separators: [
            "\n\n",
            "\n",
            "। ",
            "॥ ",
            ". ",
            "? ",
            "! ",
            " ",
            "",
        ],

        keepSeparator: true,
    });


// ─────────────────────────────────────────────
// Hybrid chunking
// ─────────────────────────────────────────────

async function chunkPassage(
    row: PassageRow
): Promise<Chunk[]> {

    const parentId =
        `${row.query_id}-p${row.passage_index}`;


    // ─────────────────────────────────────────
    // Strategy 1:
    //
    // Short passage → preserve completely.
    // ─────────────────────────────────────────

    if (
        row.passage.length <=
        SHORT_PASSAGE_CHARS
    ) {

        return [{
            chunk_id:
                `${parentId}-c0`,

            parent_id:
                parentId,

            text:
                row.passage,

            query_id:
                row.query_id,

            language:
                row.target_lang,

            passage_index:
                row.passage_index,

            is_selected:
                row.is_selected,

            chunk_index:
                0,

            chunk_type:
                "whole",
        }];
    }


    // ─────────────────────────────────────────
    // Strategy 2:
    //
    // Long passage → LangChain.
    // ─────────────────────────────────────────

    const documents =
        await splitter.createDocuments([
            row.passage,
        ]);


    return documents.map(
        (
            document,
            index
        ): Chunk => ({

            chunk_id:
                `${parentId}-c${index}`,

            parent_id:
                parentId,

            text:
                document.pageContent,

            query_id:
                row.query_id,

            language:
                row.target_lang,

            passage_index:
                row.passage_index,

            is_selected:
                row.is_selected,

            chunk_index:
                index,

            chunk_type:
                "semantic",
        })
    );
}


// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<void> {

    console.log(
        "\nStarting hybrid LangChain chunking...\n"
    );


    // ─────────────────────────────────────────
    // DuckDB
    // ─────────────────────────────────────────

    const db =
        await DuckDBInstance.create(
            ":memory:"
        );

    const conn =
        await db.connect();


    // ─────────────────────────────────────────
    // Clear previous output
    // ─────────────────────────────────────────

    await writeFile(
        OUTPUT_FILE,
        "",
        "utf8"
    );


    // ─────────────────────────────────────────
    // IMPORTANT:
    //
    // Create query_id BEFORE UNNEST.
    //
    // This keeps every passage belonging to
    // the same original record under the same
    // query_id.
    // ─────────────────────────────────────────

    const result =
        await conn.runAndReadAll(`
            SELECT
                query_id,
                target_lang,
                passage_index,
                passage,
                is_selected

            FROM (
                SELECT
                    row_number() OVER () - 1
                        AS query_id,

                    target_lang,

                    unnest(
                        range(
                            0,
                            array_length(
                                passages.Translated_passages
                            )
                        )
                    ) AS passage_index,

                    unnest(
                        passages.Translated_passages
                    ) AS passage,

                    unnest(
                        passages.is_selected
                    ) AS is_selected

                FROM (
                    SELECT
                        target_lang,
                        passages

                    FROM read_parquet(
                        '${INPUT_FILE}'
                    )

                    LIMIT ${MAX_RECORDS}
                )
            )
        `);


    const rows =
        result.getRowObjects();


    console.log(
        `Loaded ${rows.length} passages.\n`
    );


    let totalChunks = 0;

    let wholeChunks = 0;

    let semanticChunks = 0;


    // ─────────────────────────────────────────
    // Process passages
    // ─────────────────────────────────────────

    for (
        let index = 0;
        index < rows.length;
        index++
    ) {

        const rawRow =
            rows[index];


        if (!rawRow) {
            continue;
        }


        const row: PassageRow = {

            query_id:
                Number(
                    rawRow.query_id ?? 0
                ),

            target_lang:
                String(
                    rawRow.target_lang ?? "hi"
                ),

            passage_index:
                Number(
                    rawRow.passage_index ?? 0
                ),

            passage:
                String(
                    rawRow.passage ?? ""
                ).trim(),

            is_selected:
                Number(
                    rawRow.is_selected ?? 0
                ) === 1,
        };


        if (!row.passage) {
            continue;
        }


        const chunks =
            await chunkPassage(row);


        for (const chunk of chunks) {

            await appendFile(
                OUTPUT_FILE,

                JSON.stringify(chunk) +
                "\n",

                "utf8"
            );


            totalChunks++;


            if (
                chunk.chunk_type ===
                "whole"
            ) {

                wholeChunks++;

            } else {

                semanticChunks++;
            }
        }


        if (
            (index + 1) % 10_000 === 0
        ) {

            console.log(
                `Processed passages: ${
                    index + 1
                } | Chunks: ${
                    totalChunks
                }`
            );
        }
    }


    // ─────────────────────────────────────────
    // Final statistics
    // ─────────────────────────────────────────

    console.log(
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        "HYBRID CHUNKING COMPLETE"
    );

    console.log(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );

    console.log(
        "Input passages:",
        rows.length
    );

    console.log(
        "Total chunks:",
        totalChunks
    );

    console.log(
        "Whole passage chunks:",
        wholeChunks
    );

    console.log(
        "LangChain semantic chunks:",
        semanticChunks
    );

    console.log(
        "Average chunks / passage:",
        rows.length === 0
            ? 0
            : totalChunks / rows.length
    );

    console.log(
        "Chunk size:",
        CHUNK_SIZE
    );

    console.log(
        "Chunk overlap:",
        CHUNK_OVERLAP
    );

    console.log(
        "Output:",
        OUTPUT_FILE
    );
}


await main();