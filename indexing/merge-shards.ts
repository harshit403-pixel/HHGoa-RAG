import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { INDEX_ROOT } from "./pipeline/config.js";
import { VectorIndex } from "./pipeline/faiss-index.js";

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

    const db0 = new Database(path.join(shard0Dir, "metadata.db"));
    const rows0 = db0.prepare("SELECT faiss_id FROM chunks").all() as { faiss_id: number | bigint }[];
    const ids0 = rows0.map(r => BigInt(r.faiss_id));
    db0.close();

    const db1 = new Database(path.join(shard1Dir, "metadata.db"));
    const rows1 = db1.prepare("SELECT faiss_id FROM chunks").all() as { faiss_id: number | bigint }[];
    const ids1 = rows1.map(r => BigInt(r.faiss_id));
    db1.close();

    const mergedIndex = VectorIndex.create();
    const BATCH_SIZE = 50000;

    // Merge shard 0 vectors
    for (let i = 0; i < ids0.length; i += BATCH_SIZE) {
        const slice = ids0.slice(i, i + BATCH_SIZE);
        console.log(`  Reconstructing Shard 0 vectors [${i} to ${Math.min(i + BATCH_SIZE, ids0.length)}]...`);
        const vectors = index0.reconstructBatch(slice);
        mergedIndex.addBatch(slice, new Float32Array(vectors));
    }

    // Merge shard 1 vectors
    for (let i = 0; i < ids1.length; i += BATCH_SIZE) {
        const slice = ids1.slice(i, i + BATCH_SIZE);
        console.log(`  Reconstructing Shard 1 vectors [${i} to ${Math.min(i + BATCH_SIZE, ids1.length)}]...`);
        const vectors = index1.reconstructBatch(slice);
        mergedIndex.addBatch(slice, new Float32Array(vectors));
    }

    await mergedIndex.save(path.join(targetDir, "index.faiss"));
    console.log(`FAISS index merged successfully. Total vectors: ${mergedIndex.ntotal}`);

    // 3. Copy shard0's metadata.db to target and attach/merge shard1
    console.log(`Merging SQLite databases...`);
    const targetDbFile = path.join(targetDir, "metadata.db");
    const shard1DbFile = path.join(shard1Dir, "metadata.db");
    
    // Copy file first to keep schema and shard0 rows
    await fs.copyFile(path.join(shard0Dir, "metadata.db"), targetDbFile);
    
    // Attach and insert shard1 rows
    const db = new Database(targetDbFile);
    db.exec(`ATTACH DATABASE '${shard1DbFile}' AS shard1Db`);
    
    const initialRows = (db.prepare("SELECT count(*) as count FROM chunks").get() as any).count;
    db.exec(`INSERT OR REPLACE INTO chunks SELECT * FROM shard1Db.chunks`);
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
            nextFaissId: Math.max(state0.nextFaissId, state1.nextFaissId),
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

async function run() {
    const selectedLangs = process.argv.slice(2);
    
    if (selectedLangs.length > 0) {
        for (const lang of selectedLangs) {
            // e.g. "hintrain" if they run "npx tsx merge-shards.ts hintrain"
            const cleanedLang = lang.replace(/_shard[01]/g, "");
            await mergeLanguageShards(cleanedLang);
        }
    } else {
        // Scan INDEX_ROOT for folders ending in _shard0 and auto-discover
        console.log("No languages specified. Scanning index root for shards...");
        const entries = await fs.readdir(INDEX_ROOT, { withFileTypes: true });
        const languages = new Set<string>();
        
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.endsWith("_shard0")) {
                languages.add(entry.name.slice(0, -7));
            }
        }
        
        if (languages.size === 0) {
            console.log("No sharded languages found to merge.");
            return;
        }
        
        for (const lang of languages) {
            await mergeLanguageShards(lang);
        }
    }
}

run().catch(console.error);
