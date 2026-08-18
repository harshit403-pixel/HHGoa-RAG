// ─────────────────────────────────────────────
// indexing/verify-embedder.ts
// ─────────────────────────────────────────────
//
// Run this once whenever EMBEDDING_MODEL changes, BEFORE
// starting a real indexing run. It embeds a couple of
// throwaway strings and reports the actual output
// dimension so you can set EMBEDDING_DIMENSION correctly.
// Getting this wrong mid-run means every vector already
// added to the FAISS index has the wrong width and the
// index is unusable.
//
// Usage:
//   npx tsx indexing/verify-embedder.ts
// ─────────────────────────────────────────────

import { createEmbedder } from "./embedder.ts";

async function main(): Promise<void> {
    const embedder = createEmbedder();

    console.log(`Provider check: model="${embedder.model}"`);
    console.log(`Configured EMBEDDING_DIMENSION: ${embedder.dimension}`);
    console.log("Embedding a 2-sentence probe batch...\n");

    const started = Date.now();

    const vectors = await embedder.embed([
        "यह एक परीक्षण वाक्य है।",
        "This is a test sentence for dimension verification.",
    ]);

    const elapsedMs = Date.now() - started;

    const actualDimension = vectors.length / 2;

    console.log(`Actual output dimension: ${actualDimension}`);
    console.log(`Elapsed: ${elapsedMs}ms for 2 texts`);

    if (actualDimension !== embedder.dimension) {
        console.log(
            `\n⚠️  MISMATCH: set EMBEDDING_DIMENSION=${actualDimension} before indexing.`
        );
        process.exitCode = 1;
    } else {
        console.log("\n✓ Dimension matches configuration. Safe to index.");
    }
}

await main();
