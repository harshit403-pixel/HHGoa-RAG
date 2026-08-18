// ─────────────────────────────────────────────
// benchmark/retrieval.ts
// ─────────────────────────────────────────────
//
// Measures embedding latency, FAISS search latency, and
// end-to-end latency across a grid of (topK, efSearch)
// values, reporting p50/p95/p99 for each combination.
//
// Usage:
//   npx tsx benchmark/retrieval.ts --language hi --queries ./bench-queries.txt
//
// If --queries is omitted, a small built-in sample of
// generic queries is used — fine for a smoke test, but
// for meaningful recall/latency numbers pass real queries
// representative of production traffic.
// ─────────────────────────────────────────────

import "dotenv/config";
import fs from "node:fs/promises";

import { createEmbedder } from "./embedder.ts";
import { LanguageSearcher } from "./search.ts";

const DEFAULT_QUERIES = [
    "what is the capital of France",
    "how does photosynthesis work",
    "symptoms of the common cold",
    "history of the internet",
    "best practices for password security",
];

const TOP_K_VALUES = [5, 10, 20];
const EF_SEARCH_VALUES = [16, 32, 64, 128];

interface LatencySample {
    embedMs: number;
    searchMs: number;
    totalMs: number;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(
        sorted.length - 1,
        Math.floor((p / 100) * sorted.length)
    );
    return sorted[index] ?? 0;
}

function summarize(samples: number[]): { p50: number; p95: number; p99: number } {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}

function parseArgs(): { language: string; queriesFile: string | undefined } {
    const args = process.argv.slice(2);
    let language = "en";
    let queriesFile: string | undefined;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--language") language = args[++i] ?? language;
        if (args[i] === "--queries") queriesFile = args[++i];
    }

    return { language, queriesFile };
}

async function loadQueries(queriesFile: string | undefined): Promise<string[]> {
    if (!queriesFile) return DEFAULT_QUERIES;

    const raw = await fs.readFile(queriesFile, "utf8");
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
    const { language, queriesFile } = parseArgs();
    const queries = await loadQueries(queriesFile);

    console.log(`\nBenchmarking retrieval for language="${language}" with ${queries.length} queries.\n`);

    const embedder = createEmbedder();
    const searcher = await LanguageSearcher.open(language, embedder);

    console.log(
        `${"topK".padStart(6)} ${"efSearch".padStart(9)} ` +
        `${"embed p50".padStart(11)} ${"embed p95".padStart(11)} ` +
        `${"search p50".padStart(12)} ${"search p95".padStart(12)} ` +
        `${"e2e p50".padStart(9)} ${"e2e p95".padStart(9)} ${"e2e p99".padStart(9)}`
    );

    for (const efSearch of EF_SEARCH_VALUES) {
        for (const topK of TOP_K_VALUES) {

            const samples: LatencySample[] = [];

            for (const query of queries) {
                // Embed once, timed on its own.
                const embedStarted = performance.now();
                const queryVector = await embedder.embed([query]);
                const embedMs = performance.now() - embedStarted;

                // Then search using the already-computed vector,
                // timed separately. searchRaw() (see search.ts)
                // skips re-embedding so this isolates FAISS-only
                // latency at the given efSearch/topK.
                const searchStarted = performance.now();
                searcher.searchWithVector(queryVector, topK, { efSearch });
                const searchMs = performance.now() - searchStarted;

                samples.push({
                    embedMs,
                    searchMs,
                    totalMs: embedMs + searchMs,
                });
            }

            const embedStats = summarize(samples.map((s) => s.embedMs));
            const searchStats = summarize(samples.map((s) => s.searchMs));
            const totalStats = summarize(samples.map((s) => s.totalMs));

            console.log(
                `${String(topK).padStart(6)} ${String(efSearch).padStart(9)} ` +
                `${embedStats.p50.toFixed(1).padStart(11)} ${embedStats.p95.toFixed(1).padStart(11)} ` +
                `${searchStats.p50.toFixed(1).padStart(12)} ${searchStats.p95.toFixed(1).padStart(12)} ` +
                `${totalStats.p50.toFixed(1).padStart(9)} ${totalStats.p95.toFixed(1).padStart(9)} ${totalStats.p99.toFixed(1).padStart(9)}`
            );
        }
    }

    searcher.close();
    console.log("\nDone. All latencies in milliseconds.");
}

await main();
