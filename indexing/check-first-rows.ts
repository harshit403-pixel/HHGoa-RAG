import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs";
import path from "node:path";

async function main() {
    const dir = "/data/hfData/train";
    if (!fs.existsSync(dir)) {
        console.error(`Directory not found: ${dir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith(".parquet"))
        .sort()
        .map(f => path.join(dir, f));

    console.log(`Found ${files.length} Parquet files in ${dir}`);

    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();

    for (const file of files) {
        const baseName = path.basename(file);
        console.log(`\n================================================================================`);
        console.log(`FILE: ${baseName}`);
        console.log(`================================================================================`);

        try {
            const res = await conn.stream(`
                SELECT passages
                FROM read_parquet('${file}')
                LIMIT 3
            `);

            let chunk;
            let rowIndex = 0;
            while ((chunk = await res.fetchChunk())) {
                const rows = chunk.getRowObjects(res.deduplicatedColumnNames());
                for (const row of rows) {
                    rowIndex++;
                    console.log(`\n  --- Row ${rowIndex} ---`);
                    
                    const passagesObj = row.passages as any;
                    const englishPassages = passagesObj?.entries?.English_passages;

                    if (Array.isArray(englishPassages)) {
                        console.log(`  Count of English passages: ${englishPassages.length}`);
                        englishPassages.forEach((p, idx) => {
                            const snippet = String(p || "").replace(/\n/g, " ").substring(0, 120);
                            console.log(`    [Passage ${idx}]: "${snippet}..."`);
                        });
                    } else {
                        console.log(`  No English passages found or invalid structure.`);
                    }
                }
            }
        } catch (err: any) {
            console.error(`  Error reading ${baseName}:`, err.message || err);
        }
    }

    conn.disconnectSync();
}

main().catch(console.error);
