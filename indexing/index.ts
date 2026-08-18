import { DuckDBInstance } from "@duckdb/node-api";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import fs from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const TRAIN_DIR = "/data/MSMARCO-XI/train";
const OUTPUT_DIR = "./data/hybrid-chunks";

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

interface FileStats {
    file: string;
    passages: number;
    totalChunks: number;
    wholeChunks: number;
    semanticChunks: number;
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
//
// NOTE: splitter is stateless per-call, so it's
// safe to share a single instance across all
// concurrent file-processing promises.
// ─────────────────────────────────────────────

const splitter = new RecursiveCharacterTextSplitter({
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

async function chunkPassage(row: PassageRow): Promise<Chunk[]> {
    const parentId = `${row.query_id}-p${row.passage_index}`;

    // Strategy 1: short passage → preserve completely.
    if (row.passage.length <= SHORT_PASSAGE_CHARS) {
        return [{
            chunk_id: `${parentId}-c0`,
            parent_id: parentId,
            text: row.passage,
            query_id: row.query_id,
            language: row.target_lang,
            passage_index: row.passage_index,
            is_selected: row.is_selected,
            chunk_index: 0,
            chunk_type: "whole",
        }];
    }

    // Strategy 2: long passage → LangChain.
    const documents = await splitter.createDocuments([row.passage]);

    return documents.map((document, index): Chunk => ({
        chunk_id: `${parentId}-c${index}`,
        parent_id: parentId,
        text: document.pageContent,
        query_id: row.query_id,
        language: row.target_lang,
        passage_index: row.passage_index,
        is_selected: row.is_selected,
        chunk_index: index,
        chunk_type: "semantic",
    }));
}

// ─────────────────────────────────────────────
// Per-file processing
// ─────────────────────────────────────────────
//
// Each language file gets its own DuckDB
// connection and its own output file. This is
// what makes it safe to run all 13 languages
// concurrently via Promise.all — no shared
// mutable file handle, no interleaved writes.
// ─────────────────────────────────────────────

async function processFile(filePath: string): Promise<FileStats> {
    const baseName = path.basename(filePath, path.extname(filePath));
    const outputFile = path.join(OUTPUT_DIR, `${baseName}.jsonl`);

    console.log(`[${baseName}] starting...`);

    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();

    await fs.writeFile(outputFile, "", "utf8");

    const result = await conn.runAndReadAll(`
        SELECT
            query_id,
            target_lang,
            passage_index,
            passage,
            is_selected

        FROM (
            SELECT
                row_number() OVER () - 1 AS query_id,
                target_lang,

                unnest(
                    range(0, array_length(passages.Translated_passages))
                ) AS passage_index,

                unnest(passages.Translated_passages) AS passage,
                unnest(passages.is_selected) AS is_selected

            FROM (
                SELECT
                    target_lang,
                    passages

                FROM read_parquet('${filePath}')
                LIMIT ${MAX_RECORDS}
            )
        )
    `);

    const rows = result.getRowObjects();

    let totalChunks = 0;
    let wholeChunks = 0;
    let semanticChunks = 0;

    // Buffer lines per file and write in batches instead of
    // one appendFile per chunk — much faster under concurrency.
    const buffer: string[] = [];
    const FLUSH_EVERY = 500;

    const flush = async () => {
        if (buffer.length === 0) return;
        await fs.appendFile(outputFile, buffer.join(""), "utf8");
        buffer.length = 0;
    };

    for (let index = 0; index < rows.length; index++) {
        const rawRow = rows[index];
        if (!rawRow) continue;

        const row: PassageRow = {
            query_id: Number(rawRow.query_id ?? 0),
            target_lang: String(rawRow.target_lang ?? baseName),
            passage_index: Number(rawRow.passage_index ?? 0),
            passage: String(rawRow.passage ?? "").trim(),
            is_selected: Number(rawRow.is_selected ?? 0) === 1,
        };

        if (!row.passage) continue;

        const chunks = await chunkPassage(row);

        for (const chunk of chunks) {
            buffer.push(JSON.stringify(chunk) + "\n");
            totalChunks++;

            if (chunk.chunk_type === "whole") {
                wholeChunks++;
            } else {
                semanticChunks++;
            }
        }

        if (buffer.length >= FLUSH_EVERY) {
            await flush();
        }

        if ((index + 1) % 10_000 === 0) {
            console.log(
                `[${baseName}] processed: ${index + 1} | chunks: ${totalChunks}`
            );
        }
    }

    await flush();
    conn.disconnectSync();

    console.log(`[${baseName}] done — ${totalChunks} chunks from ${rows.length} passages.`);

    return {
        file: baseName,
        passages: rows.length,
        totalChunks,
        wholeChunks,
        semanticChunks,
    };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("\nStarting multi-language hybrid LangChain chunking...\n");

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const entries = await fs.readdir(TRAIN_DIR, { withFileTypes: true });

    const parquetFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".parquet"))
        .map((entry) => path.join(TRAIN_DIR, entry.name));

    console.log(`Found ${parquetFiles.length} parquet files:\n`);
    parquetFiles.forEach((f) => console.log("  -", f));
    console.log();

    // One promise per language, all running concurrently.
    const results = await Promise.all(
        parquetFiles.map((filePath) => processFile(filePath))
    );

    // ─────────────────────────────────────────
    // Final statistics
    // ─────────────────────────────────────────

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("MULTI-LANGUAGE HYBRID CHUNKING COMPLETE");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    let grandPassages = 0;
    let grandTotal = 0;
    let grandWhole = 0;
    let grandSemantic = 0;

    for (const stats of results) {
        console.log(
            `${stats.file.padEnd(15)} passages: ${stats.passages
                .toString()
                .padStart(6)} | total: ${stats.totalChunks
                .toString()
                .padStart(6)} | whole: ${stats.wholeChunks
                .toString()
                .padStart(6)} | semantic: ${stats.semanticChunks
                .toString()
                .padStart(6)}`
        );

        grandPassages += stats.passages;
        grandTotal += stats.totalChunks;
        grandWhole += stats.wholeChunks;
        grandSemantic += stats.semanticChunks;
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Total input passages:", grandPassages);
    console.log("Total chunks:", grandTotal);
    console.log("Whole passage chunks:", grandWhole);
    console.log("LangChain semantic chunks:", grandSemantic);
    console.log(
        "Average chunks / passage:",
        grandPassages === 0 ? 0 : grandTotal / grandPassages
    );
    console.log("Chunk size:", CHUNK_SIZE);
    console.log("Chunk overlap:", CHUNK_OVERLAP);
    console.log("Output dir:", OUTPUT_DIR);
}

await main();