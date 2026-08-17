/**
 * src/ai/embeddings.ts
 *
 * Vector Embedding Generator for CockroachDB Distributed Vector Indexing.
 *
 * Uses Gemini embeddings and requests 768 output dimensions to match the schema.
 */

import { config } from "dotenv";

config({ path: ".env.local" });

function getApiKey(): string {
    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in .env.local — cannot generate vector embeddings.");
    }
    return apiKey;
}

/**
 * Generate a 768-dimensional vector embedding for any text string.
 * Fails clearly when a real semantic embedding cannot be generated.
 */
export async function getEmbedding(text: string): Promise<number[]> {
    const cleanText = text.toLowerCase().replace(/\n+/g, " ").trim();

    const modelName = process.env["GEMINI_EMBEDDING_MODEL"] ?? "gemini-embedding-001";
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:embedContent`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": getApiKey(),
            },
            body: JSON.stringify({
                model: `models/${modelName}`,
                content: { parts: [{ text: cleanText }] },
                outputDimensionality: 768,
            }),
        },
    );
    if (!response.ok) {
        throw new Error(`Gemini embedding request failed with HTTP ${response.status}`);
    }
    const result = (await response.json()) as { embedding?: { values?: number[] } };
    const values = result.embedding?.values;
    if (!values || values.length !== 768) {
        throw new Error(
            `${modelName} returned ${values?.length ?? 0} dimensions; expected 768. ` +
                "Configure a model/output dimension compatible with VECTOR(768).",
        );
    }
    return values;
}

/**
 * Convert a JavaScript number array into CockroachDB SQL VECTOR literal format:
 * e.g. '[0.0123, -0.0456, 0.7891]'
 */
export function formatVectorForCockroach(vector: number[]): string {
    return `[${vector.join(",")}]`;
}
