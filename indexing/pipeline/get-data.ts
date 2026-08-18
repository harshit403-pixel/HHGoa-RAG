import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs/promises";
import path from "node:path";
import type { PassageRow } from "./types.ts";

// ─────────────────────────────────────────────
// listParquetFiles
// ─────────────────────────────────────────────
//
// Scans a directory (e.g. a GCS FUSE mount) and
// returns absolute paths to every *.parquet file
// in it. One entry per language file.
// ─────────────────────────────────────────────

export async function listParquetFiles(
    dir: string
): Promise<string[]> {

    const entries = await fs.readdir(dir, {
        withFileTypes: true,
    });

    return entries
        .filter(
            (entry) =>
                entry.isFile() &&
                entry.name.endsWith(".parquet")
        )
        .map((entry) => path.join(dir, entry.name));
}

// ─────────────────────────────────────────────
// streamPassagesFromParquet (default export)
// ─────────────────────────────────────────────
//
// Files are ~4GB each, so we never materialize the
// full result set. connection.stream() + fetchChunk()
// pulls rows in bounded batches (DuckDB's internal
// vector size, ~2048 rows/chunk) straight off disk,
// so memory stays flat regardless of file size.
//
// Consume it with `for await (const batch of ...)` —
// each `batch` is a small PassageRow[] you can chunk
// and write immediately, then let it be GC'd.
// ─────────────────────────────────────────────

export default async function* streamPassagesFromParquet(
    filePath: string,
    maxRecords?: number
): AsyncGenerator<PassageRow[], void, unknown> {

    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();

    const baseName = path.basename(
        filePath,
        path.extname(filePath)
    );

    // Only apply LIMIT when a cap is explicitly passed.
    // Leaving maxRecords undefined streams every record
    // in the file.
    const limitClause =
        maxRecords !== undefined
            ? `LIMIT ${maxRecords}`
            : "";

    try {
        const result = await conn.stream(`
            SELECT
                query_id,
                target_lang,
                passage_index,
                passage,
                is_selected

            FROM (
                SELECT
                    row_number() OVER () - 1 AS query_id,
                    target_lang,

                    unnest(
                        range(0, array_length(passages.Translated_passages))
                    ) AS passage_index,

                    unnest(passages.Translated_passages) AS passage,
                    unnest(passages.is_selected) AS is_selected

                FROM (
                    SELECT
                        target_lang,
                        passages

                    FROM read_parquet('${filePath}')
                    ${limitClause}
                )
            )
        `);

        while (true) {
            const chunk = await result.fetchChunk();

            if (!chunk || chunk.rowCount === 0) {
                break;
            }

            const rawRows = chunk.getRowObjects(
                result.deduplicatedColumnNames()
            );

            const rows: PassageRow[] = [];

            for (const rawRow of rawRows) {
                if (!rawRow) continue;

                const row: PassageRow = {
                    query_id: Number(rawRow.query_id ?? 0),
                    target_lang: String(
                        rawRow.target_lang ?? baseName
                    ),
                    passage_index: Number(
                        rawRow.passage_index ?? 0
                    ),
                    passage: String(
                        rawRow.passage ?? ""
                    ).trim(),
                    is_selected:
                        Number(rawRow.is_selected ?? 0) === 1,
                };

                if (!row.passage) continue;

                rows.push(row);
            }

            if (rows.length > 0) {
                yield rows;
            }
        }

    } finally {
        conn.disconnectSync();
    }
}
