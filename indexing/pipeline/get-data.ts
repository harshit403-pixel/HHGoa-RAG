import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs/promises";
import path from "node:path";
import type { PassageRow } from "./types.ts";
import logger from "./logger.js";

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
    logger.info({ dir }, "Scanning directory for Parquet files");
    const entries = await fs.readdir(dir, {
        withFileTypes: true,
    });

    const files = entries
        .filter(
            (entry) =>
                entry.isFile() &&
                entry.name.endsWith(".parquet")
        )
        .map((entry) => path.join(dir, entry.name));

    logger.info({ dir, count: files.length }, "Found Parquet files");
    return files;
}

// ─────────────────────────────────────────────
// getParquetRowCount
// ─────────────────────────────────────────────
//
// Fast point-in-time check of the total rows in the
// parquet file using DuckDB, used for progress bars.
// ─────────────────────────────────────────────

export async function getParquetRowCount(
    filePath: string
): Promise<number> {
    logger.info({ filePath }, "Checking row count for Parquet file");
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    try {
        const result = await conn.stream(`
            SELECT count(*)::BIGINT as total
            FROM read_parquet('${filePath}')
        `);
        const chunk = await result.fetchChunk();
        if (chunk) {
            const rows = chunk.getRowObjects(result.deduplicatedColumnNames());
            const total = Number(rows[0]?.total ?? 0);
            logger.info({ filePath, total }, "Successfully retrieved Parquet row count");
            return total;
        }
        return 0;
    } finally {
        conn.disconnectSync();
    }
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

interface DuckDBListValue<T> {
    items: T[];
}

interface DuckDBStructValue {
    entries: {
        Translated_passages?: DuckDBListValue<unknown>;
        is_selected?: DuckDBListValue<unknown>;
    };
}

export default async function* streamPassagesFromParquet(
    filePath: string,
    offset?: number,
    limit?: number
): AsyncGenerator<PassageRow[], void, unknown> {
    logger.info({ filePath, offset, limit }, "Starting DuckDB parquet stream reader");
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();

    const baseName = path.basename(
        filePath,
        path.extname(filePath)
    );

    const limitOffsetClause =
        limit !== undefined
            ? `LIMIT ${limit} OFFSET ${offset ?? 0}`
            : "";

    try {
        const result = await conn.stream(`
            SELECT
                target_lang,
                passages
            FROM read_parquet('${filePath}')
            ${limitOffsetClause}
        `);

        let queryId = offset ?? 0;

        while (true) {
            const chunk = await result.fetchChunk();

            if (!chunk || chunk.rowCount === 0) {
                logger.info({ filePath }, "Parquet stream reader reached end of file");
                break;
            }

            const rawRows = chunk.getRowObjects(
                result.deduplicatedColumnNames()
            );

            logger.info(
                { filePath, rawRowCount: rawRows.length },
                "Fetched chunk from DuckDB, parsing in batches of 20 original rows"
            );

            const rows: PassageRow[] = [];
            let rowsInBatch = 0;

            for (const rawRow of rawRows) {
                if (!rawRow) continue;

                const targetLang = String(rawRow.target_lang ?? baseName);
                const passages = rawRow.passages as DuckDBStructValue | undefined;

                if (passages && passages.entries.Translated_passages) {
                    const texts = passages.entries.Translated_passages.items;
                    const selected = passages.entries.is_selected?.items ?? [];

                    for (let i = 0; i < texts.length; i++) {
                        const passageText = String(texts[i] ?? "").trim();
                        if (!passageText) continue;

                        const row: PassageRow = {
                            query_id: queryId,
                            target_lang: targetLang,
                            passage_index: i,
                            passage: passageText,
                            is_selected: Number(selected[i] ?? 0) === 1,
                        };
                        rows.push(row);
                    }
                }
                queryId++;
                rowsInBatch++;

                if (rowsInBatch >= 20) {
                    if (rows.length > 0) {
                        logger.debug(
                            { filePath, batchPassages: rows.length, queryIdStart: queryId - 20, queryIdEnd: queryId - 1 },
                            "Yielding sub-batch of 20 original Parquet rows"
                        );
                        yield rows;
                        rows.length = 0;
                    }
                    rowsInBatch = 0;
                }
            }

            if (rows.length > 0) {
                logger.debug(
                    { filePath, batchPassages: rows.length },
                    "Yielding remaining rows in chunk"
                );
                yield rows;
            }
        }

    } finally {
        conn.disconnectSync();
        logger.info({ filePath }, "Closed DuckDB connection for parquet stream reader");
    }
}
