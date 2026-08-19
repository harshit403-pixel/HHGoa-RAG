import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import streamPassagesFromParquet from "./get-data.ts";
import { INDEX_ROOT } from "./config.ts";
import logger from "./logger.ts";

const TOTAL_ROWS = 778638;
const BATCH_SIZE = 5000;

// Map file prefixes to 2-letter ISO language codes
const LANG_MAP: Record<string, string> = {
    "asmtrain": "as",
    "bentrain": "bn",
    "gujtrain": "gu",
    "hintrain": "hi",
    "kantrain": "kn",
    "maltrain": "ml",
    "martrain": "mr",
    "neptrain": "ne",
    "oritrain": "or",
    "pantrain": "pa",
    "santrain": "sa",
    "tamtrain": "ta",
    "urdtrain": "ur"
};

export async function runInject(): Promise<void> {
    const destDir = path.join(INDEX_ROOT, "aligned_english");
    const dbFile = path.join(destDir, "metadata.db");

    if (!fsSync.existsSync(dbFile)) {
        throw new Error(`Unified database does not exist at ${dbFile}. Please run merge first.`);
    }

    logger.info({ dbFile }, "Starting local translation metadata injection");

    const db = new Database(dbFile);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = OFF"); // Turn off synchronous to maximize UPDATE speed

    const updateStmt = db.prepare(`
        UPDATE chunks
        SET translations = json_set(translations, '$["' || :lang || '"]', :text)
        WHERE query_id = :query_id AND passage_index = :passage_index
    `);

    const updateBatch = db.transaction((rows: any[], lang: string) => {
        for (const row of rows) {
            updateStmt.run({
                lang,
                text: row.passage,
                query_id: row.query_id,
                passage_index: row.passage_index
            });
        }
    });

    const trainDir = "/data/hfData/train";
    const files = fsSync.readdirSync(trainDir)
        .filter(f => f.endsWith(".parquet"))
        .sort();

    for (const file of files) {
        const prefix = path.basename(file, ".parquet").toLowerCase();
        const langCode = LANG_MAP[prefix];
        
        if (!langCode) {
            logger.warn({ file }, `Unknown language prefix for file, skipping`);
            continue;
        }

        const filePath = path.join(trainDir, file);
        logger.info({ file, langCode }, `Injecting [${prefix}] translations into metadata...`);

        const startedAt = Date.now();
        let batchBuffer: any[] = [];
        let totalInjected = 0;

        for await (const rowBatch of streamPassagesFromParquet(filePath, 0, TOTAL_ROWS, false)) {
            for (const row of rowBatch) {
                batchBuffer.push(row);

                if (batchBuffer.length >= BATCH_SIZE) {
                    updateBatch(batchBuffer, langCode);
                    totalInjected += batchBuffer.length;
                    batchBuffer = [];
                }
            }
        }

        // Flush remaining buffer
        if (batchBuffer.length > 0) {
            updateBatch(batchBuffer, langCode);
            totalInjected += batchBuffer.length;
        }

        const elapsedSec = (Date.now() - startedAt) / 1000;
        logger.info(
            { langCode, file, totalInjected, elapsedSec: `${elapsedSec.toFixed(1)}s` },
            `Successfully injected [${prefix}] translations!`
        );
    }

    db.pragma("synchronous = NORMAL");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    logger.info("Successfully finished translation metadata injection for all 13 languages!");
}
