export interface PassageRow {
    query_id: number;
    target_lang: string;
    passage_index: number;
    passage: string;
    is_selected: boolean;
}

export interface Chunk {
    chunk_id: string;
    parent_id: string;

    text: string;

    query_id: number;
    language: string;

    passage_index: number;
    is_selected: boolean;

    chunk_index: number;

    chunk_type: "whole" | "semantic";
}

export interface FileStats {
    file: string;
    passages: number;
    totalChunks: number;
    wholeChunks: number;
    semanticChunks: number;
}
