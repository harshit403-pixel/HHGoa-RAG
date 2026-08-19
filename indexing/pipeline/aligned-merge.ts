import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { VectorIndex } from "./faiss-index.ts";
import { INDEX_ROOT } from "./config.ts";
import logger from "./logger.ts";

const DEFAULT_NUM_SHARDS = 10;
const BATCH_SIZE = 50000;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS chunks (
        faiss_id       INTEGER PRIMARY KEY,
        chunk_id       TEXT NOT NULL,
        parent_id      TEXT NOT NULL,
        text           TEXT NOT NULL,
        query_id       INTEGER NOT NULL,
        passage_index  INTEGER NOT NULL,
        chunk_index    INTEGER NOT NULL,
        chunk_type     TEXT NOT NULL,
        translations   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_query_passage ON chunks(query_id, passage_index);
`;

export async function runMerge(numShards = DEFAULT_NUM_SHARDS): Promise<void> {
    const destDir = path.join(INDEX_ROOT, "aligned_english");
    const destIndexFile = path.join(destDir, "index.faiss");
    const destDbFile = path.join(destDir, "metadata.db");

    logger.info({ destDir }, "Starting merge of 10 English shards into unified index");

    // Clean destination directory
    if (fsSync.existsSync(destDir)) {
        await fs.rm(destDir, { recursive: true, force: true });
    }
    await fs.mkdir(destDir, { recursive: true });

    // Initialize unified SQLite database
    const destDb = new Database(destDbFile);
    destDb.pragma("journal_mode = WAL");
    destDb.pragma("synchronous = OFF"); // Speed up batch inserts during merge
    destDb.exec(SCHEMA);

    const mergedIndex = VectorIndex.create({ dimension: 1024, indexType: "hnsw" });

    for (let shardIndex = 0; shardIndex < numShards; shardIndex++) {
        const shardName = `aligned_shard${shardIndex}`;
        const shardDir = path.join(INDEX_ROOT, shardName);
        const shardIndexFile = path.join(shardDir, "index.faiss");
        const shardDbFile = path.join(shardDir, "metadata.db");
        const stateFile = path.join(shardDir, "state.json");

        logger.info({ shardName }, `Merging shard ${shardIndex}...`);

        if (!fsSync.existsSync(shardIndexFile) || !fsSync.existsSync(shardDbFile)) {
            logger.warn({ shardIndexFile, shardDbFile }, `Shard files missing - skipping shard ${shardIndex}`);
            continue;
        }

        // 1. Merge Vector Index (reconstruct HNSW vectors and insert)
        const shardIndexObj = await VectorIndex.load(shardIndexFile);
        const ntotal = shardIndexObj.ntotal;
        const startFaissId = shardIndex * 50_000_000;

        logger.info({ shardName, ntotal }, `Reconstructing vectors for ${shardName}`);

        let processed = 0;
        while (processed < ntotal) {
            const currentBatch = Math.min(BATCH_SIZE, ntotal - processed);
            const batchStartId = startFaissId + processed;

            const ids = Array.from({ length: currentBatch }, (_, idx) => BigInt(batchStartId + idx));
            const flatVectors = shardIndexObj.reconstructBatch(ids);

            // Insert into the merged index
            mergedIndex.addBatch(ids, new Float32Array(flatVectors));
            processed += currentBatch;
            
            logger.info(`  Reconstructed vectors [${processed}/${ntotal}]...`);
        }

        // 2. Merge SQLite Database (fast ATTACH copy)
        logger.info({ shardName }, `Merging SQLite database for ${shardName}`);
        
        try {
            destDb.prepare(`ATTACH DATABASE '${shardDbFile.replace(/'/g, "''")}' AS shard_db`).run();
            destDb.prepare("INSERT INTO main.chunks SELECT * FROM shard_db.chunks").run();
            destDb.prepare("DETACH DATABASE shard_db").run();
        } catch (e: any) {
            logger.error({ shardName, error: e.message }, "Error during SQLite merge, skipping database insert");
            throw e;
        }
    }

    // Save final merged FAISS index
    logger.info({ destIndexFile }, "Saving unified index.faiss");
    await mergedIndex.save(destIndexFile);

    // Save final state.json
    const stateFile = path.join(destDir, "state.json");
    await fs.writeFile(
        stateFile,
        JSON.stringify(
            {
                language: "aligned_english",
                sourceFile: "/data/hfData/train/asmtrain.parquet",
                completed: true,
                updatedAt: new Date().toISOString(),
            },
            null,
            2
        )
    );

    destDb.pragma("synchronous = NORMAL");
    destDb.pragma("wal_checkpoint(TRUNCATE)");
    destDb.close();

    logger.info({ destDir }, "Successfully merged 10 English shards into unified aligned_english index!");
}
