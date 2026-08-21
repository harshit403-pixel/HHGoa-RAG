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

export function warmupSearcher(): void {
    try {
        logger.info("Eagerly warming up FAISS searcher and SQLite database caches...");
        const activeFolder = "aligned_english";
        const searcher = getSearcher(activeFolder);
        
        // Execute 70 diverse queries with semi-random embeddings to populate V8 heap, OS cache, and SQLite buffer pools
        for (let i = 0; i < 70; i++) {
            const dummyVector = new Float32Array(1024);
            for (let j = 0; j < 1024; j++) {
                dummyVector[j] = Math.random() - 0.5;
            }
            searcher.search(dummyVector, 5);
        }
        logger.info("RAG searcher warmup completed successfully with 70 diverse queries.");
    } catch (e: any) {
        logger.warn({ error: e.message }, "Searcher warmup failed (index files may be missing or not compiled yet)");
    }
}

export async function handleQuery(req: Request, res: Response): Promise<void> {
    // 1. Establish Server-Sent Events (SSE) connection
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as any).flush === "function") {
            (res as any).flush();
        }
    };

    const pipelineStart = performance.now();
    let queryText = "";
    let userLanguage = "en-IN";
    let sttMs = 0;
    let translationMs = 0;
    let guardrailsMs = 0;
    let embedMs = 0;
    let searchMs = 0;
    let groundingMs = 0;
    let retrieveMs = 0;

    try {
        // 2. Handle audio input (STT) or text input
        if (req.file) {
            sendEvent("status", { step: "stt_start", message: "RAG pipeline started - Transcribing audio...", timestamp: Date.now() });
            const sttStart = performance.now();
            const transcription = await transcribeAudio(req.file.buffer, req.file.originalname);
            sttMs = Number((performance.now() - sttStart).toFixed(4));

            queryText = transcription.transcript;
            userLanguage = transcription.language_code || "en-IN";
            sendEvent("status", { 
                step: "stt_done", 
                message: `[Speech-to-Text] took ${sttMs} ms. Transcribed: "${queryText}"`, 
                queryText,
                userLanguage,
                timestamp: Date.now(), 
                latency: sttMs 
            });
        } else {
            const body = req.body || {};
            queryText = String(body.query || "").trim();
            userLanguage = String(body.language || "en-IN").trim();
            sendEvent("status", { 
                step: "stt_none", 
                message: `RAG pipeline started - Received text query: "${queryText}"`, 
                queryText,
                userLanguage,
                timestamp: Date.now() 
            });
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
            sendEvent("status", { step: "translate_start", message: `Translating query to English...`, timestamp: Date.now() });
            const transStart = performance.now();
            // Translate the query to English (en-IN)
            const translation = await translateText(queryText, userLanguage, "en-IN");
            translationMs = Number((performance.now() - transStart).toFixed(4));
            translatedQuery = translation.translated_text;
            sendEvent("status", { 
                step: "translate_done", 
                message: `[Query Translation] took ${translationMs} ms. Translated: "${translatedQuery}"`, 
                translatedQuery,
                timestamp: Date.now(), 
                latency: translationMs 
            });
        }

        // 4b. Input Safety & Off-Topic Guardrail Check
        sendEvent("status", { step: "guardrails_start", message: "Running safety and off-topic guardrails...", timestamp: Date.now() });
        const guardStart = performance.now();
        const inputGuard = await ModelHarness.checkInputGuardrail(queryText);
        guardrailsMs = Number((performance.now() - guardStart).toFixed(4));
        if (!inputGuard.passed) {
            logger.warn({ queryText, reason: inputGuard.reason }, "Input rejected by guardrails");
            sendEvent("status", { step: "guardrails_failed", message: `[Guardrails Rejection] took ${guardrailsMs} ms. Blocked: ${inputGuard.reason}`, timestamp: Date.now() });
            sendEvent("error", { message: `Blocked: ${inputGuard.reason}` });
            res.end();
            return;
        }
        sendEvent("status", { step: "guardrails_done", message: `[Guardrails Analysis] took ${guardrailsMs} ms. Status: Passed.`, timestamp: Date.now(), latency: guardrailsMs });

        // 5. Embed the query using Mistral with Retry Orchestrator
        sendEvent("status", { step: "embed_start", message: "Generating query vector embedding...", timestamp: Date.now() });
        const queryToEmbed = translationNeeded ? translatedQuery : queryText;
        const embedStart = performance.now();
        const queryVector = await ModelHarness.executeWithRetry(() => getEmbedding(queryToEmbed));
        embedMs = Number((performance.now() - embedStart).toFixed(4));
        sendEvent("status", { 
            step: "embed_done", 
            message: `[Vector Embedding] took ${embedMs} ms`, 
            timestamp: Date.now(), 
            latency: embedMs 
        });

        // 6. Vector similarity search in the unified English index
        sendEvent("status", { step: "search_start", message: "Searching local FAISS vector index...", timestamp: Date.now() });
        const searcher = getSearcher(activeFolder);
        const searchStart = performance.now();
        const rawResults = searcher.search(queryVector, 5);
        searchMs = Number((performance.now() - searchStart).toFixed(4));
        sendEvent("status", { 
            step: "search_done", 
            message: `[Vector Index Search] took ${searchMs} ms. Found ${rawResults.length} matches.`, 
            timestamp: Date.now(), 
            latency: searchMs 
        });

        logger.info({ folder: activeFolder, count: rawResults.length, searchMs, embedMs }, "FAISS search complete");

        // 6b. Groundedness / Hallucination Guardrail Check
        sendEvent("status", { step: "grounding_start", message: "Checking retrieval groundedness thresholds...", timestamp: Date.now() });
        const groundingStart = performance.now();
        const groundingGuard = ModelHarness.checkRetrievalGrounding(rawResults);
        groundingMs = Number((performance.now() - groundingStart).toFixed(4));
        if (!groundingGuard.passed) {
            logger.info({ queryText, reason: groundingGuard.reason }, "Refusing to answer due to grounding guardrails");
            sendEvent("status", { step: "grounding_failed", message: `[Groundedness Verification] took ${groundingMs} ms. Status: Rejected (${groundingGuard.reason})`, timestamp: Date.now() });
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
                retrieveMs: 0,
                totalMs: Number((performance.now() - pipelineStart).toFixed(4)),
                citations: []
            });
            sendEvent("chunk", { text: "I cannot find the answer in the provided documents." });
            sendEvent("done", {});
            res.end();
            return;
        }
        sendEvent("status", { step: "grounding_done", message: `[Groundedness Verification] took ${groundingMs} ms. Status: Passed.`, timestamp: Date.now(), latency: groundingMs });

        // 7. Extract the target language translation locally from the database (zero external API calls!)
        sendEvent("status", { step: "retrieve_start", message: "Retrieving multilingual translations from SQLite DB...", timestamp: Date.now() });
        const retrieveStart = performance.now();
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
        retrieveMs = Number((performance.now() - retrieveStart).toFixed(4));
        sendEvent("status", { step: "retrieve_done", message: `[Local Metadata Retrieval] took ${retrieveMs} ms. Fetched 5 context translations.`, timestamp: Date.now(), latency: retrieveMs });

        // Calculate and send RAG pipeline end event
        const totalMs = Number((performance.now() - pipelineStart).toFixed(4));
        sendEvent("status", { step: "pipeline_done", message: `RAG pipeline ended in ${totalMs} ms`, timestamp: Date.now(), latency: totalMs });

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
            retrieveMs,
            totalMs,
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

        // Send the exact prompt given to AI
        sendEvent("status", { step: "prompt_given", message: `Prompt given to AI:\n\n${systemPrompt}\n\n[User Query]: "${queryText}"`, timestamp: Date.now() });

        logger.info("Starting streaming Mistral chat completion response");
        for await (const chunk of streamChatCompletion(systemPrompt, queryText)) {
            sendEvent("chunk", { text: chunk });
        }
        sendEvent("status", { step: "generate_done", message: "Grounded response stream completed.", timestamp: Date.now() });

        sendEvent("done", {});
        res.end();
    } catch (err: any) {
        logger.error({ error: err.message }, "Error during query retrieval pipeline");
        sendEvent("error", { message: err.message || "An unexpected error occurred" });
        res.end();
    }
}
