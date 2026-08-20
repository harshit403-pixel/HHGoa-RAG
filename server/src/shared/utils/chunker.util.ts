export interface ChunkResult {
    text: string;
    index: number;
    chunk_type: "whole" | "fixed" | "semantic";
}

/**
 * Advanced Chunking Utilities containing multiple strategies
 * (Whole, Fixed-size with Overlap, and Semantic sentence grouping).
 */
export class AdvancedChunker {
    /**
     * Chunker Strategy 1: Whole passage strategy (keeps text fully intact)
     */
    static chunkWhole(text: string): ChunkResult[] {
        return [{ text: text.trim(), index: 0, chunk_type: "whole" }];
    }

    /**
     * Chunker Strategy 2: Fixed-size sentence window with overlapping
     * (e.g. window of 3 sentences with 1 sentence overlap)
     */
    static chunkFixedSizeOverlap(text: string, windowSize = 3, overlapSize = 1): ChunkResult[] {
        // Split by sentences
        const sentences = text
            .split(/(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        if (sentences.length <= windowSize) {
            return [{ text: text.trim(), index: 0, chunk_type: "fixed" }];
        }

        const chunks: ChunkResult[] = [];
        let index = 0;

        for (let i = 0; i < sentences.length; i += (windowSize - overlapSize)) {
            const window = sentences.slice(i, i + windowSize);
            if (window.length === 0) break;

            chunks.push({
                text: window.join(" "),
                index,
                chunk_type: "fixed"
            });
            index++;

            // Break if the remaining sentences fit in this window
            if (i + windowSize >= sentences.length) {
                break;
            }
        }

        return chunks;
    }

    /**
     * Chunker Strategy 3: Semantic paragraph chunker
     * (Splits by paragraphs or blocks of text)
     */
    static chunkSemantic(text: string): ChunkResult[] {
        const paragraphs = text
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

        return paragraphs.map((p, idx) => ({
            text: p,
            index: idx,
            chunk_type: "semantic"
        }));
    }
}
