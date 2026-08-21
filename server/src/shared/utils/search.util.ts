import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import env from "../config/env.config.js";
import logger from "../config/logger.config.js";

const INDEX_ROOT = env.INDEX_ROOT || "/data/hhgoa/indexes";

const requireLoc = createRequire(import.meta.url);
let faiss: any;
let Database: any;

try {
    // Try loading standard production dependencies (e.g. inside Docker / Render environment)
    faiss = requireLoc("faiss-node");
    Database = requireLoc("better-sqlite3");
} catch (e: any) {
    logger.info("Could not load native dependencies from standard server node_modules. Falling back to precompiled indexing modules...");
    // Fallback for local Windows VM development using precompiled indexing assets
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    let rootDir = __dirname;
    while (rootDir && !fs.existsSync(path.join(rootDir, "indexing")) && path.dirname(rootDir) !== rootDir) {
        rootDir = path.dirname(rootDir);
    }
    faiss = requireLoc(path.join(rootDir, "indexing/node_modules/faiss-napi"));
    Database = requireLoc(path.join(rootDir, "indexing/node_modules/better-sqlite3"));
}

export interface SearchResult {
    score: number;
    chunk_id: string;
    parent_id: string;
    text: string;
    language: string;
    query_id: number;
    passage_index: number;
    chunk_index: number;
    chunk_type: "whole" | "semantic";
    translations?: string;
}

/**
 * Maps standard ISO-2, ISO-3, and BCP-47 language codes to the physical index folder names.
 */
const LANG_MAP: Record<string, string> = {
    "hi": "hintrain",
    "hin": "hintrain",
    "hi-in": "hintrain",
    "gu": "gujtrain",
    "guj": "gujtrain",
    "gu-in": "gujtrain",
    "en": "engtrain",
    "eng": "engtrain",
    "en-in": "engtrain",
    "ben": "bentrain",
    "bn": "bentrain",
    "bn-in": "bentrain",
    "kan": "kantrain",
    "kn": "kantrain",
    "kn-in": "kantrain",
    "mal": "maltrain",
    "ml": "maltrain",
    "ml-in": "maltrain",
    "mar": "martrain",
    "mr": "martrain",
    "mr-in": "martrain",
    "nep": "neptrain",
    "ne": "neptrain",
    "ne-in": "neptrain",
    "ori": "oritrain",
    "or": "oritrain",
    "or-in": "oritrain",
    "pan": "pantrain",
    "pa": "pantrain",
    "pa-in": "pantrain",
    "san": "santrain",
    "sa": "santrain",
    "sa-in": "santrain",
    "tam": "tamtrain",
    "ta": "tamtrain",
    "ta-in": "tamtrain",
    "urd": "urdtrain",
    "ur": "urdtrain",
    "ur-in": "urdtrain"
};

export class LanguageSearcher {
    private readonly index: any;
    private readonly db: any;
    private readonly selectStmt: any;

    constructor(faissFile: string, dbFile: string) {
        logger.info({ faissFile, dbFile }, "Loading native FAISS index and metadata store");
        
        // Native C++ load (no V8 buffer size limitations)
        this.index = faiss.Index.read(faissFile);
        this.db = new Database(dbFile, { readonly: true });
        this.selectStmt = this.db.prepare("SELECT * FROM chunks WHERE faiss_id = ?");
    }

    /**
     * Executes vector similarity search on the loaded FAISS index and retrieves metadata from SQLite.
     */
    search(queryVector: Float32Array, topK: number): SearchResult[] {
        const vectorArr = Array.from(queryVector);
        const { labels, distances } = this.index.search(vectorArr, topK);
        
        const results: SearchResult[] = [];

        for (let i = 0; i < labels.length; i++) {
            const faissId = Number(labels[i]);
            // faiss-node pads results with -1 if index size < topK
            if (faissId < 0) continue;

            const row = this.selectStmt.get(faissId) as any;
            if (!row) continue;

            results.push({
                score: -distances[i], // Similarity convention (closer distance -> higher score)
                chunk_id: row.chunk_id,
                parent_id: row.parent_id,
                text: row.text,
                language: row.language,
                query_id: row.query_id,
                passage_index: row.passage_index,
                chunk_index: row.chunk_index,
                chunk_type: row.chunk_type,
                translations: row.translations,
            });
        }

        return results;
    }

    close(): void {
        this.db.close();
    }
}

/**
 * Checks which language indexes are completed and available on disk.
 * Returns a Map of language folder name to index folder path.
 */
export function scanAvailableIndexes(): Map<string, string> {
    const available = new Map<string, string>();
    if (!fs.existsSync(INDEX_ROOT)) {
        logger.warn({ INDEX_ROOT }, "Index root directory does not exist yet");
        return available;
    }

    const entries = fs.readdirSync(INDEX_ROOT);
    for (const entry of entries) {
        const fullPath = path.join(INDEX_ROOT, entry);
        if (!fs.statSync(fullPath).isDirectory()) continue;

        // Skip shard folders (only want merged target folders)
        if (entry.includes("_shard")) continue;

        const faissFile = path.join(fullPath, "index.faiss");
        const dbFile = path.join(fullPath, "metadata.db");
        
        if (fs.existsSync(faissFile) && fs.existsSync(dbFile)) {
            const stateFile = path.join(fullPath, "state.json");
            let isCompleted = true;

            if (fs.existsSync(stateFile)) {
                try {
                    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
                    isCompleted = state.completed === true;
                } catch {
                    isCompleted = false;
                }
            }

            if (isCompleted) {
                available.set(entry.toLowerCase(), fullPath);
            }
        }
    }

    logger.info({ available: Array.from(available.keys()) }, "Scanned and verified available language indexes");
    return available;
}

/**
 * Resolves the language code to the matching index folder name, checking disk availability.
 */
export function resolveIndexFolder(languageCode: string, availableIndexes: Map<string, string>): string | null {
    const normalized = languageCode.toLowerCase().trim();
    const folderName = LANG_MAP[normalized];
    if (!folderName) {
        return null;
    }
    return availableIndexes.has(folderName) ? folderName : null;
}
