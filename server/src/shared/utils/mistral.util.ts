import { ChatMistralAI } from "@langchain/mistralai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import env from "../config/env.config.js";
import logger from "../config/logger.config.js";

const apiKeys: string[] = [];

// Load keys using the exact same priority/logic
const firstKey = env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY1;
if (firstKey) {
    apiKeys.push(firstKey.trim());
}
for (let i = 2; i <= 50; i++) {
    const key = process.env[`MISTRAL_API_KEY${i}`];
    if (key && key.trim()) {
        apiKeys.push(key.trim());
    }
}

let keyIndex = 0;

/**
 * Returns a Mistral API key from the pool (simple round-robin).
 */
function getApiKey(): string {
    if (apiKeys.length === 0) {
        throw new Error("No Mistral API keys configured in environment variables");
    }
    const key = apiKeys[keyIndex];
    keyIndex = (keyIndex + 1) % apiKeys.length;
    return key;
}

/**
 * Instantiates and returns a configured ChatMistralAI agent using the next key in the pool.
 */
export function createAgent(): ChatMistralAI {
    const apiKey = getApiKey();
    return new ChatMistralAI({
        modelName: "mistral-large-latest",
        apiKey: apiKey,
        temperature: 0,
    });
}

/**
 * Calls Mistral API to generate a 1024-dimension text embedding vector.
 */
export async function getEmbedding(text: string): Promise<Float32Array> {
    const apiKey = getApiKey();
    
    const response = await fetch("https://api.mistral.ai/v1/embeddings", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: "mistral-embed",
            input: [text],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Mistral Embeddings API error ${response.status}: ${errorText}`);
    }

    interface MistralEmbeddingResponse {
        data: {
            embedding: number[];
            index: number;
        }[];
    }

    const result = (await response.json()) as MistralEmbeddingResponse;
    const embedding = result.data[0]?.embedding;
    if (!embedding) {
        throw new Error("Mistral API returned empty embedding data");
    }

    return new Float32Array(embedding);
}

/**
 * Calls Mistral Chat Completion API in streaming mode using LangChain's ChatMistralAI agent.
 * Yields text tokens as they arrive.
 */
export async function* streamChatCompletion(
    systemPrompt: string,
    userMessage: string
): AsyncGenerator<string, void, unknown> {
    const agent = createAgent();

    try {
        const stream = await agent.stream([
            new SystemMessage(systemPrompt),
            new HumanMessage(userMessage),
        ]);

        for await (const chunk of stream) {
            if (typeof chunk.content === "string" && chunk.content) {
                yield chunk.content;
            }
        }
    } catch (err: any) {
        logger.error({ error: err.message }, "Error during LangChain ChatMistralAI stream execution");
        throw new Error(`LangChain LLM Error: ${err.message}`);
    }
}
