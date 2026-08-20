import { Request, Response } from "express";
import { transcribeAudio, translateText } from "../utils/sarvam.util.js";
import { getEmbedding, streamChatCompletion } from "../utils/mistral.util.js";
import { LanguageSearcher, scanAvailableIndexes, resolveIndexFolder, SearchResult } from "../utils/search.util.js";
import { ModelHarness } from "../utils/harness.util.js";
import logger from "../config/logger.config.js";
import path from "node:path";
import env from "../config/env.config.js";

const INDEX_ROOT = env.INDEX_ROOT || "/data/hhgoa/indexes";
const loadedSearchers = new Map<string, LanguageSearcher>();

/**
 * Gets or loads a LanguageSearcher instance for the given index folder.
 */
function getSearcher(folderName: string): LanguageSearcher {
    let searcher = loadedSearchers.get(folderName);
    if (!searcher) {
        const dir = path.join(INDEX_ROOT, folderName);
        const faissFile = path.join(dir, "index.faiss");
        const dbFile = path.join(dir, "metadata.db");
        
        searcher = new LanguageSearcher(faissFile, dbFile);
        loadedSearchers.set(folderName, searcher);
    }
    return searcher;
}

export async function handleQuery(req: Request, res: Response): Promise<void> {
    // 1. Establish Server-Sent Events (SSE) connection
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let queryText = "";
    let userLanguage = "en-IN";
    let sttMs = 0;
    let translationMs = 0;
    let searchMs = 0;

    try {
        // 2. Handle audio input (STT) or text input
        if (req.file) {
            const sttStart = performance.now();
            const transcription = await transcribeAudio(req.file.buffer, req.file.originalname);
            sttMs = Math.round(performance.now() - sttStart);

            queryText = transcription.transcript;
            userLanguage = transcription.language_code || "en-IN";
        } else {
            const body = req.body || {};
            queryText = String(body.query || "").trim();
            userLanguage = String(body.language || "en-IN").trim();
        }

        if (!queryText) {
            sendEvent("error", { message: "Empty query text or transcription" });
            res.end();
            return;
        }

        logger.info({ queryText, userLanguage, sttMs }, "Query received");

        // 3. Scan completed indexes on disk dynamically
        const availableIndexes = scanAvailableIndexes();
        const baseLang = userLanguage.split("-")[0]?.toLowerCase() || "en";
        
        const activeFolder = "aligned_english";
        if (!availableIndexes.has(activeFolder)) {
            sendEvent("error", { 
                message: `The target index folder "${activeFolder}" is not completed or available on disk at ${INDEX_ROOT}` 
            });
            res.end();
            return;
        }

        let translationNeeded = baseLang !== "en";
        let translatedQuery = "";

        // 4. Translate query to English if the input language is not English
        if (translationNeeded) {
            const transStart = performance.now();
            // Translate the query to English (en-IN)
            const translation = await translateText(queryText, userLanguage, "en-IN");
            translationMs += Math.round(performance.now() - transStart);
            translatedQuery = translation.translated_text;
        }

        // 4b. Input Safety & Off-Topic Guardrail Check
        const inputGuard = await ModelHarness.checkInputGuardrail(queryText);
        if (!inputGuard.passed) {
            logger.warn({ queryText, reason: inputGuard.reason }, "Input rejected by guardrails");
            sendEvent("error", { message: `Blocked: ${inputGuard.reason}` });
            res.end();
            return;
        }

        // 5. Embed the query using Mistral with Retry Orchestrator
        const queryToEmbed = translationNeeded ? translatedQuery : queryText;
        const embedStart = performance.now();
        const queryVector = await ModelHarness.executeWithRetry(() => getEmbedding(queryToEmbed));
        const embedMs = Math.round(performance.now() - embedStart);

        // 6. Vector similarity search in the unified English index
        const searcher = getSearcher(activeFolder);
        const searchStart = performance.now();
        const rawResults = searcher.search(queryVector, 5);
        searchMs = Math.round(performance.now() - searchStart);

        logger.info({ folder: activeFolder, count: rawResults.length, searchMs, embedMs }, "FAISS search complete");

        // 6b. Groundedness / Hallucination Guardrail Check
        const groundingGuard = ModelHarness.checkRetrievalGrounding(rawResults);
        if (!groundingGuard.passed) {
            logger.info({ queryText, reason: groundingGuard.reason }, "Refusing to answer due to grounding guardrails");
            sendEvent("metadata", {
                query: queryText,
                userLanguage,
                searchedIndex: activeFolder,
                translationNeeded,
                translatedQuery,
                sttMs,
                translationMs,
                searchMs,
                embedMs,
                citations: []
            });
            sendEvent("chunk", { text: "I cannot find the answer in the provided documents." });
            sendEvent("done", {});
            res.end();
            return;
        }

        // 7. Extract the target language translation locally from the database (zero external API calls!)
        const citations = rawResults.map(r => {
            let text = r.text; // Default to English
            if (baseLang !== "en" && r.translations) {
                try {
                    const transObj = JSON.parse(r.translations);
                    if (transObj[baseLang]) {
                        text = transObj[baseLang];
                    }
                } catch (e: any) {
                    logger.warn({ error: e.message }, "Failed to parse translations JSON from database metadata");
                }
            }
            return {
                ...r,
                text
            };
        });

        // Send metadata & citations to the frontend immediately
        sendEvent("metadata", {
            query: queryText,
            userLanguage,
            searchedIndex: activeFolder,
            translationNeeded,
            translatedQuery,
            sttMs,
            translationMs,
            searchMs,
            embedMs,
            citations: citations.map(c => ({
                chunk_id: c.chunk_id,
                score: c.score,
                text: c.text,
                language: c.language,
                passage_index: c.passage_index
            }))
        });

        // 8. Generate answer using Mistral Chat API
        const contextString = citations.map((c, i) => `[Source ${i + 1}]: ${c.text}`).join("\n\n");
        const systemPrompt = `You are a professional assistant. Answer the user's question in detail based ONLY on the provided context. If the context does not contain the answer, say "I cannot find the answer in the provided documents." DO NOT make up information.
Your response MUST be written in the user's language: ${userLanguage}.

Context:
${contextString}`;

        logger.info("Starting streaming Mistral chat completion response");
        for await (const chunk of streamChatCompletion(systemPrompt, queryText)) {
            sendEvent("chunk", { text: chunk });
        }

        sendEvent("done", {});
        res.end();
    } catch (err: any) {
        logger.error({ error: err.message }, "Error during query retrieval pipeline");
        sendEvent("error", { message: err.message || "An unexpected error occurred" });
        res.end();
    }
}
