import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";

import streamPassagesFromParquet, {
    listParquetFiles,
} from "./get-data.js";

import chunkPassage from "./chunk-data.js";

import type { FileStats } from "./types.ts";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const TRAIN_DIR = "/data/hfData/train";
const OUTPUT_DIR = "./data/hybrid-chunks";

// No cap — streams every record in each parquet file.
// Pass a number here (e.g. 10_000) if you want to
// limit rows per file for a quick test run.
const MAX_RECORDS: number | undefined = undefined;

// GCS FUSE mount + many concurrent DuckDB scans can
// saturate the mount's effective throughput. Cap
// concurrency so files queue instead of all fighting
// for bandwidth at once. Each file is also streamed
// (not loaded fully into memory), so this mainly
// controls I/O concurrency, not memory.
const FILE_CONCURRENCY = 6;

// Chunk JSONL lines are buffered and flushed together
// instead of one appendFile per line, so disk writes
// stay efficient even with 6 files running at once.
const FLUSH_EVERY = 500;

// ─────────────────────────────────────────────
// processFile
// ─────────────────────────────────────────────
//
// Streams rows for one language file in bounded
// batches via streamPassagesFromParquet, chunks each
// row via chunkPassage, and writes to its own output
// file. At no point does this hold the full ~4GB
// file's rows in memory — only the current DuckDB
// batch (~2048 rows) plus the small write buffer.
// ─────────────────────────────────────────────

async function processFile(filePath: string): Promise<FileStats> {

    const baseName = path.basename(
        filePath,
        path.extname(filePath)
    );

    const outputFile = path.join(OUTPUT_DIR, `${baseName}.jsonl`);

    console.log(`[${baseName}] starting...`);

    await fs.writeFile(outputFile, "", "utf8");

    let passages = 0;
    let totalChunks = 0;
    let wholeChunks = 0;
    let semanticChunks = 0;

    const buffer: string[] = [];

    const flush = async () => {
        if (buffer.length === 0) return;
        await fs.appendFile(outputFile, buffer.join(""), "utf8");
        buffer.length = 0;
    };

    for await (const rowBatch of streamPassagesFromParquet(
        filePath,
        MAX_RECORDS
    )) {

        for (const row of rowBatch) {
            passages++;

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

            if (passages % 10_000 === 0) {
                console.log(
                    `[${baseName}] processed: ${passages} | chunks: ${totalChunks}`
                );
            }
        }

        // rowBatch goes out of scope here and is eligible
        // for GC before the next batch is pulled off the
        // stream — this is what keeps memory flat.
    }

    await flush();

    console.log(
        `[${baseName}] done — ${totalChunks} chunks from ${passages} passages.`
    );

    return {
        file: baseName,
        passages,
        totalChunks,
        wholeChunks,
        semanticChunks,
    };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<void> {

    console.log("\nStarting multi-language hybrid LangChain chunking pipeline...\n");

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const parquetFiles = await listParquetFiles(TRAIN_DIR);

    console.log(`Found ${parquetFiles.length} parquet files:\n`);
    parquetFiles.forEach((f) => console.log("  -", f));
    console.log(`\nRunning with max ${FILE_CONCURRENCY} files in flight at once (streamed, not fully loaded).\n`);

    // One promise per language, capped at FILE_CONCURRENCY
    // running at once — the rest queue and start as slots free.
    const limit = pLimit(FILE_CONCURRENCY);

    const results = await Promise.all(
        parquetFiles.map((filePath) =>
            limit(() => processFile(filePath))
        )
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
    console.log("Output dir:", OUTPUT_DIR);
}

await main();
