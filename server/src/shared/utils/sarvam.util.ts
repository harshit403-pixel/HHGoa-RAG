import env from "../config/env.config.js";
import logger from "../config/logger.config.js";

interface TranscribeResponse {
    transcript: string;
    language_code: string;
}

interface TranslateResponse {
    translated_text: string;
    source_language_code: string;
}

const SARVAM_API_KEY = env.SARVAM_API_KEY || process.env.SARVAM_API_KEY || "";

/**
 * Sends an audio file buffer to Sarvam AI REST API for transcription.
 */
export async function transcribeAudio(
    fileBuffer: Buffer,
    originalName: string
): Promise<TranscribeResponse> {
    if (!SARVAM_API_KEY) {
        throw new Error("SARVAM_API_KEY is not configured");
    }

    logger.info({ filename: originalName, size: fileBuffer.length }, "Transcribing audio via Sarvam AI API");

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: "audio/wav" });
    formData.append("file", blob, originalName);
    formData.append("model", "saaras:v3");

    const response = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: {
            "api-subscription-key": SARVAM_API_KEY,
        },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Sarvam STT API error ${response.status}: ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as { transcript: string; language_code: string };
    logger.info({ language_code: data.language_code, transcriptLength: data.transcript.length }, "Transcription successful");

    return data;
}

/**
 * Translates text between English and Indian languages using Sarvam Translate API.
 */
export async function translateText(
    input: string,
    sourceLanguageCode: string,
    targetLanguageCode: string
): Promise<TranslateResponse> {
    if (!SARVAM_API_KEY) {
        throw new Error("SARVAM_API_KEY is not configured");
    }

    logger.info(
        { source: sourceLanguageCode, target: targetLanguageCode, inputLength: input.length },
        "Translating text via Sarvam AI API"
    );

    const response = await fetch("https://api.sarvam.ai/translate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "api-subscription-key": SARVAM_API_KEY,
        },
        body: JSON.stringify({
            input,
            source_language_code: sourceLanguageCode,
            target_language_code: targetLanguageCode,
            model: "mayura:v1",
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Sarvam Translation API error ${response.status}: ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as TranslateResponse;
    logger.info("Translation completed successfully");

    return data;
}
