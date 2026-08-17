import { DuckDBInstance } from "@duckdb/node-api";

const db = await DuckDBInstance.create(":memory:");
const conn = await db.connect();

const files = {
    train: "./data/hintrain.parquet",
    validation: "./data/hinval.parquet",
};


// ─────────────────────────────────────────────
// Inspect one dataset
// ─────────────────────────────────────────────

async function inspectFile(
    name: string,
    file: string
) {
    console.log(
        `\n\n━━━━━━━━━━ ${name.toUpperCase()} ━━━━━━━━━━`
    );


    // ─────────────────────────────────────────
    // Dataset size
    // ─────────────────────────────────────────

    const count = await conn.runAndReadAll(`
        SELECT COUNT(*) AS total_records
        FROM read_parquet('${file}')
    `);

    console.table(count.getRowObjects());


    // ─────────────────────────────────────────
    // Passage statistics
    // ─────────────────────────────────────────

    const passageStats = await conn.runAndReadAll(`
        SELECT
            COUNT(*) AS total_passages,

            AVG(length(passage))
                AS avg_chars,

            quantile_cont(length(passage), 0.50)
                AS p50_chars,

            quantile_cont(length(passage), 0.90)
                AS p90_chars,

            quantile_cont(length(passage), 0.99)
                AS p99_chars,

            MIN(length(passage))
                AS min_chars,

            MAX(length(passage))
                AS max_chars

        FROM (
            SELECT
                unnest(passages.Translated_passages)
                    AS passage

            FROM read_parquet('${file}')
        )
        WHERE passage IS NOT NULL
    `);

    console.log("\nPASSAGE LENGTHS");
    console.table(
        passageStats.getRowObjects()
    );


    // ─────────────────────────────────────────
    // Passages per record
    // ─────────────────────────────────────────

    const passagesPerRecord =
        await conn.runAndReadAll(`
            SELECT
                AVG(
                    array_length(
                        passages.Translated_passages
                    )
                ) AS avg_passages,

                quantile_cont(
                    array_length(
                        passages.Translated_passages
                    ),
                    0.50
                ) AS p50_passages,

                quantile_cont(
                    array_length(
                        passages.Translated_passages
                    ),
                    0.90
                ) AS p90_passages,

                MAX(
                    array_length(
                        passages.Translated_passages
                    )
                ) AS max_passages

            FROM read_parquet('${file}')
        `);

    console.log("\nPASSAGES PER RECORD");

    console.table(
        passagesPerRecord.getRowObjects()
    );


    // ─────────────────────────────────────────
    // Query statistics
    // ─────────────────────────────────────────

    const queryStats = await conn.runAndReadAll(`
        SELECT
            AVG(length(query))
                AS avg_query_chars,

            quantile_cont(
                length(query),
                0.50
            ) AS p50_query_chars,

            quantile_cont(
                length(query),
                0.90
            ) AS p90_query_chars,

            quantile_cont(
                length(query),
                0.99
            ) AS p99_query_chars

        FROM read_parquet('${file}')
        WHERE query IS NOT NULL
    `);

    console.log("\nQUERY LENGTHS");

    console.table(
        queryStats.getRowObjects()
    );


    // ─────────────────────────────────────────
    // Answer statistics
    // ─────────────────────────────────────────

    const answerStats = await conn.runAndReadAll(`
        SELECT
            AVG(length("Answer"))
                AS avg_answer_chars,

            quantile_cont(
                length("Answer"),
                0.50
            ) AS p50_answer_chars,

            quantile_cont(
                length("Answer"),
                0.90
            ) AS p90_answer_chars,

            quantile_cont(
                length("Answer"),
                0.99
            ) AS p99_answer_chars

        FROM read_parquet('${file}')
        WHERE "Answer" IS NOT NULL
    `);

    console.log("\nANSWER LENGTHS");

    console.table(
        answerStats.getRowObjects()
    );


    // ─────────────────────────────────────────
    // Selected passages
    // ─────────────────────────────────────────

    const selectedStats = await conn.runAndReadAll(`
        SELECT
            SUM(
                CASE
                    WHEN selected = 1
                    THEN 1
                    ELSE 0
                END
            ) AS selected_passages,

            COUNT(*) AS total_passages

        FROM (
            SELECT
                unnest(passages.is_selected)
                    AS selected

            FROM read_parquet('${file}')
        )
    `);

    console.log("\nSELECTED PASSAGES");

    console.table(
        selectedStats.getRowObjects()
    );


    // ─────────────────────────────────────────
    // First 3 records
    // ─────────────────────────────────────────

    const samples = await conn.runAndReadAll(`
        SELECT
            query,
            "Answer",
            target_lang,
            passages
        FROM read_parquet('${file}')
        LIMIT 3
    `);

    console.log("\nFIRST 3 RECORDS");

    console.dir(
        samples.getRowObjects(),
        {
            depth: null,
        }
    );
}


// ─────────────────────────────────────────────
// Run inspection
// ─────────────────────────────────────────────

await inspectFile(
    "train",
    files.train
);

await inspectFile(
    "validation",
    files.validation
);