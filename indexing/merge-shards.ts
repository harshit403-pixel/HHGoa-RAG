import fs from "node:fs/promises";
import path from "node:path";
import { INDEX_ROOT } from "./pipeline/config.js";
import { mergeLanguageShards } from "./pipeline/merge-helper.js";

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
