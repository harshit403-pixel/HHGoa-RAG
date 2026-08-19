import env from "../config/env.config.js";
import logger from "../config/logger.config.js";

const apiKeys: string[] = [];

// Load keys using the exact same priority/logic
if (env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY) {
    apiKeys.push((env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || "").trim());
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
 * Calls Mistral Chat Completion API in streaming mode.
 * Yields text tokens as they arrive.
 */
export async function* streamChatCompletion(
    systemPrompt: string,
    userMessage: string
): AsyncGenerator<string, void, unknown> {
    const apiKey = getApiKey();

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: "mistral-large-latest",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
            ],
            stream: true,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Mistral Chat Completion API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
        throw new Error("Mistral API returned empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed === "data: [DONE]") continue;

                if (trimmed.startsWith("data: ")) {
                    try {
                        const parsed = JSON.parse(trimmed.slice(6));
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            yield content;
                        }
                    } catch {
                        // Skip malformed/incomplete JSON lines
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
