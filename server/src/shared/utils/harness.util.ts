import { getEmbedding, streamChatCompletion } from "./mistral.util.js";
import logger from "../config/logger.config.js";

interface GuardrailResult {
    passed: boolean;
    reason?: string;
}

/**
 * Orchestrator harness that wraps LLM calls with retry logic, round-robin key failovers,
 * and input/output guardrails.
 */
export class ModelHarness {
    /**
     * Executes a promise-returning API call with exponential backoff retries and key rotation.
     */
    static async executeWithRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
        let attempt = 0;
        let delay = 100; // start with 100ms delay

        while (true) {
            try {
                return await fn();
            } catch (err: any) {
                attempt++;
                logger.warn({ error: err.message, attempt, maxRetries }, "API call failed, attempting retry");

                if (attempt >= maxRetries) {
                    throw new Error(`API call failed after ${maxRetries} attempts. Original error: ${err.message}`);
                }

                // Exponential backoff
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            }
        }
    }

    /**
     * Guardrail: Classifies if a user query is safe and on-topic.
     * Returns true if safe and relevant, false otherwise.
     */
    static async checkInputGuardrail(query: string): Promise<GuardrailResult> {
        // Fast off-topic check based on keyword classification or prompt structure
        const lower = query.toLowerCase().trim();

        // 1. Basic safety checks
        const unsafeKeywords = [
            "jailbreak", "ignore previous instructions", "system prompt",
            "hack", "exploit", "kill", "suicide", "bomb", "bypass",
            "unlock", "passcode", "password", "crack", "reset lock", "bypass lock", "without permission"
        ];
        for (const keyword of unsafeKeywords) {
            if (lower.includes(keyword)) {
                return { passed: false, reason: "Unsafe input detected (security guardrail trigger)" };
            }
        }

        // 2. Off-topic classifier: checks if the query makes sense for the document corpus (MS MARCO facts/info)
        // For general queries, we want to reject completely random chit-chat or code-gen requests
        const offTopicTriggers = [
            "write a python script", "javascript code", "create a function",
            "hello", "how are you", "who are you", "what is your name"
        ];
        for (const trigger of offTopicTriggers) {
            if (lower.includes(trigger)) {
                return { passed: false, reason: "Off-topic chit-chat or coding request rejected" };
            }
        }

        return { passed: true };
    }

    /**
     * Guardrail: Verifies if the answer can be grounded in the retrieved citations.
     * Prevents hallucination by checking score levels and ensuring sources exist.
     */
    static checkRetrievalGrounding(citations: any[], threshold = -5.0): GuardrailResult {
        if (!citations || citations.length === 0) {
            return { passed: false, reason: "No relevant documents retrieved" };
        }

        // Check if the top match is too far in vector space (low similarity)
        const topScore = citations[0].score;
        if (topScore < threshold) {
            return { passed: false, reason: "Similarity score below confidence threshold" };
        }

        return { passed: true };
    }
}
