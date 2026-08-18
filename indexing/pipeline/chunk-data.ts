import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Chunk, PassageRow } from "./types.ts";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const SHORT_PASSAGE_CHARS = 900;

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 100;

// ─────────────────────────────────────────────
// LangChain splitter
// ─────────────────────────────────────────────
//
// Order matters.
//
// LangChain will prefer:
//
// paragraph
//    ↓
// newline
//    ↓
// Hindi danda
//    ↓
// double danda
//    ↓
// English punctuation
//    ↓
// spaces
//    ↓
// characters
//
// This gives us hierarchical splitting rather
// than blindly cutting every N characters.
//
// The splitter is stateless per-call, so a single
// module-level instance is safe to reuse across
// concurrent chunkPassage calls from multiple
// files in the pipeline.
// ─────────────────────────────────────────────

const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,

    separators: [
        "\n\n",
        "\n",
        "। ",
        "॥ ",
        ". ",
        "? ",
        "! ",
        " ",
        "",
    ],

    keepSeparator: true,
});

// ─────────────────────────────────────────────
// chunkPassage (default export)
// ─────────────────────────────────────────────
//
// Strategy 1: short passage → preserve whole.
// Strategy 2: long passage → LangChain semantic split.
// ─────────────────────────────────────────────

export default async function chunkPassage(
    row: PassageRow
): Promise<Chunk[]> {

    const parentId = `${row.query_id}-p${row.passage_index}`;

    if (row.passage.length <= SHORT_PASSAGE_CHARS) {
        return [{
            chunk_id: `${parentId}-c0`,
            parent_id: parentId,
            text: row.passage,
            query_id: row.query_id,
            language: row.target_lang,
            passage_index: row.passage_index,
            is_selected: row.is_selected,
            chunk_index: 0,
            chunk_type: "whole",
        }];
    }

    const documents = await splitter.createDocuments([
        row.passage,
    ]);

    return documents.map((document, index): Chunk => ({
        chunk_id: `${parentId}-c${index}`,
        parent_id: parentId,
        text: document.pageContent,
        query_id: row.query_id,
        language: row.target_lang,
        passage_index: row.passage_index,
        is_selected: row.is_selected,
        chunk_index: index,
        chunk_type: "semantic",
    }));
}
