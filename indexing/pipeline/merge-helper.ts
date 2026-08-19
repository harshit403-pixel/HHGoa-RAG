import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { INDEX_ROOT } from "./config.js";
import { VectorIndex } from "./faiss-index.js";

export async function mergeLanguageShards(language: string) {
    const shard0Dir = path.join(INDEX_ROOT, `${language}_shard0`);
    const shard1Dir = path.join(INDEX_ROOT, `${language}_shard1`);
    const targetDir = path.join(INDEX_ROOT, language);

    console.log(`\n=== Merging shards for [${language}] ===`);
    console.log(`Source Shard 0: ${shard0Dir}`);
    console.log(`Source Shard 1: ${shard1Dir}`);
    console.log(`Target Merged : ${targetDir}`);

    // Check if both shards exist
    try {
        await fs.access(path.join(shard0Dir, "metadata.db"));
        await fs.access(path.join(shard1Dir, "metadata.db"));
    } catch {
        console.error(`Error: Shard folders for [${language}] do not exist or are missing metadata.db. Skipping.`);
        return;
    }

    // 1. Recreate clean target directory
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });

    // 2. Initialize target index.faiss by loading shard0 and shard1, reconstructing vectors, and building a new index
    console.log(`Merging FAISS indexes...`);
    const index0 = await VectorIndex.load(path.join(shard0Dir, "index.faiss"));
    const index1 = await VectorIndex.load(path.join(shard1Dir, "index.faiss"));

    const n0 = index0.ntotal;
    const n1 = index1.ntotal;
    
    console.log(`Shard 0 vectors: ${n0}`);
    console.log(`Shard 1 vectors: ${n1}`);

    const mergedIndex = VectorIndex.create();
    const BATCH_SIZE = 50000;

    // Merge shard 0 vectors (IDs are contiguous locally from 0 to n0 - 1)
    for (let i = 0; i < n0; i += BATCH_SIZE) {
        const batchLimit = Math.min(i + BATCH_SIZE, n0);
        const slice: bigint[] = [];
        for (let j = i; j < batchLimit; j++) {
            slice.push(BigInt(j));
        }
        console.log(`  Reconstructing Shard 0 vectors [${i} to ${batchLimit}]...`);
        const vectors = index0.reconstructBatch(slice);
        mergedIndex.addBatch(slice, new Float32Array(vectors));
    }

    // Merge shard 1 vectors
    // Local IDs in index1 are [0 to n1 - 1]
    // Merged IDs are shifted by 500,000,000 to prevent collisions
    const shard1Start = 500000000;
    for (let i = 0; i < n1; i += BATCH_SIZE) {
        const batchLimit = Math.min(i + BATCH_SIZE, n1);
        
        // Retrieve using local IDs [0 to n1 - 1]
        const localSlice: bigint[] = [];
        for (let j = i; j < batchLimit; j++) {
            localSlice.push(BigInt(j));
        }
        
        // Add using shifted IDs [shard1Start to shard1Start + n1 - 1]
        const shiftedSlice: bigint[] = [];
        for (let j = i; j < batchLimit; j++) {
            shiftedSlice.push(BigInt(shard1Start + j));
        }

        console.log(`  Reconstructing Shard 1 vectors [${i} to ${batchLimit}]...`);
        const vectors = index1.reconstructBatch(localSlice);
        mergedIndex.addBatch(shiftedSlice, new Float32Array(vectors));
    }

    await mergedIndex.save(path.join(targetDir, "index.faiss"));
    console.log(`FAISS index merged successfully. Total vectors: ${mergedIndex.ntotal}`);

    // 3. Copy shard0's metadata.db to target and attach/merge shard1
    console.log(`Merging SQLite databases...`);
    const targetDbFile = path.join(targetDir, "metadata.db");
    const shard1DbFile = path.join(shard1Dir, "metadata.db");

    // Copy file first to keep schema and shard0 rows
    await fs.copyFile(path.join(shard0Dir, "metadata.db"), targetDbFile);

    // Open target db and delete any orphaned metadata rows exceeding FAISS index size
    const db = new Database(targetDbFile);
    const clean0 = db.prepare("DELETE FROM chunks WHERE faiss_id >= ?").run(n0);
    if (clean0.changes > 0) {
        console.log(`Removed ${clean0.changes} orphaned chunks from Shard 0 SQLite database.`);
    }

    // Attach and insert shard1 rows with shifted faiss_ids
    db.exec(`ATTACH DATABASE '${shard1DbFile}' AS shard1Db`);

    const initialRows = (db.prepare("SELECT count(*) as count FROM chunks").get() as any).count;
    
    // Insert valid rows from shard1, shifting faiss_id to match the merged FAISS index space
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO chunks (
            faiss_id, chunk_id, parent_id, text, query_id, language, passage_index, is_selected, chunk_index, chunk_type
        )
        SELECT 
            faiss_id + ?, chunk_id, parent_id, text, query_id, language, passage_index, is_selected, chunk_index, chunk_type
        FROM shard1Db.chunks 
        WHERE faiss_id < ?
    `);
    const res1 = stmt.run(shard1Start, n1);
    
    const finalRows = (db.prepare("SELECT count(*) as count FROM chunks").get() as any).count;

    db.exec(`DETACH DATABASE shard1Db`);
    db.close();
    console.log(`SQLite database merged successfully. Total rows: ${initialRows} -> ${finalRows}`);

    // 4. Merge state.json checkpoints
    console.log(`Merging checkpoint states...`);
    try {
        const state0Raw = await fs.readFile(path.join(shard0Dir, "state.json"), "utf8");
        const state1Raw = await fs.readFile(path.join(shard1Dir, "state.json"), "utf8");
        const state0 = JSON.parse(state0Raw);
        const state1 = JSON.parse(state1Raw);

        const mergedState = {
            language,
            sourceFile: state0.sourceFile,
            rowsConsumed: state0.rowsConsumed + state1.rowsConsumed,
            vectorsIndexed: state0.vectorsIndexed + state1.vectorsIndexed,
            nextFaissId: Math.max(state0.nextFaissId, state1.nextFaissId + shard1Start),
            completed: state0.completed && state1.completed,
            updatedAt: new Date().toISOString()
        };

        await fs.writeFile(
            path.join(targetDir, "state.json"),
            JSON.stringify(mergedState, null, 2),
            "utf8"
        );
        console.log(`Checkpoint merged successfully.`);
    } catch (e) {
        console.warn(`Warning: Could not merge state.json files:`, e);
    }

    console.log(`[${language}] Merging complete!`);
}
