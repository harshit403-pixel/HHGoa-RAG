import { runIngest } from "./pipeline/aligned-ingest.ts";
import { runMerge } from "./pipeline/aligned-merge.ts";
import { runInject } from "./pipeline/aligned-inject.ts";
import fs from "node:fs";
import path from "node:path";
import { INDEX_ROOT } from "./pipeline/config.ts";

const NUM_SHARDS = 10;
const SHARD_SIZE = 300;
const TOTAL_ROWS = NUM_SHARDS * SHARD_SIZE;

async function main() {
    const args = process.argv.slice(2);
    const command = args[0]?.toLowerCase();

    if (command === "shard") {
        const shardIdx = parseInt(args[1] || "", 10);
        if (isNaN(shardIdx) || shardIdx < 0 || shardIdx >= NUM_SHARDS) {
            console.error(`Error: Shard index must be between 0 and ${NUM_SHARDS - 1}`);
            process.exit(1);
        }
        await runIngest(shardIdx, NUM_SHARDS);
    } else if (command === "merge") {
        await runMerge(NUM_SHARDS);
    } else if (command === "inject") {
        await runInject();
    } else if (command === "status") {
        console.log(`\n======================================================`);
        console.log(`Ingestion Status of Aligned English Shards (0-${NUM_SHARDS - 1})`);
        console.log(`======================================================`);
        
        let totalCompletedRows = 0;
        let totalVectors = 0;
        let completedShardsCount = 0;

        for (let i = 0; i < NUM_SHARDS; i++) {
            const shardName = `aligned_shard${i}`;
            const stateFile = path.join(INDEX_ROOT, shardName, "state.json");
            
            let status = "Not Started";
            let rows = 0;
            let vectors = 0;

            if (fs.existsSync(stateFile)) {
                try {
                    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
                    rows = state.rowsConsumed || 0;
                    vectors = state.vectorsIndexed || 0;
                    status = state.completed ? "✅ Completed" : "⏳ In Progress";
                    
                    if (state.completed) {
                        completedShardsCount++;
                        rows = SHARD_SIZE; // Set to full shard limit if completed
                    }
                    totalCompletedRows += rows;
                    totalVectors += vectors;
                } catch {
                    status = "⚠️ Corrupted State";
                }
            }

            console.log(
                `* ${shardName.padEnd(16)}: ${status.padEnd(14)} | ` +
                `Rows: ${rows.toLocaleString().padStart(8)} / ${SHARD_SIZE.toLocaleString()} | ` +
                `Vectors: ${vectors.toLocaleString().padStart(8)}`
            );
        }

        const overallPct = ((totalCompletedRows / TOTAL_ROWS) * 100).toFixed(2);
        console.log(`------------------------------------------------------`);
        console.log(`Overall Progress:  ${totalCompletedRows.toLocaleString()} / ${TOTAL_ROWS.toLocaleString()} rows (${overallPct}%)`);
        console.log(`Total Vectors:     ${totalVectors.toLocaleString()} vectors`);
        console.log(`Shards Completed:  ${completedShardsCount} / ${NUM_SHARDS}`);
        console.log(`======================================================\n`);
    } else {
        console.log(`
Usage: npx tsx aligned-index.ts [command] [args]

Commands:
  shard [index]  Start an ingestion worker for the given English shard index (0-9).
                 Example: npx tsx aligned-index.ts shard 0
  
  status         Print the progress status of all 10 shards.
  
  merge          Merge all 10 shards into a single aligned_english index and database.
  
  inject         Inject translations from all 13 languages into the merged database.
`);
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
