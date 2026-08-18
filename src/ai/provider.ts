/**
 * src/ai/provider.ts
 *
 * Multi-Provider AI Brain with Automatic Fallback Cascade.
 *
 * Tries providers in order. If one fails or has no key, automatically
 * falls back to the next one. No downtime, no manual switching.
 *
 * Priority order (set in .env.local):
 *   1. Groq      (GROQ_API_KEY)       ← fastest, free 14k req/day
 *   2. Gemini    (GEMINI_API_KEY)     ← free 1500 req/day, no credit card
 *   3. Anthropic (ANTHROPIC_API_KEY)  ← paid fallback
 *
 * To disable a provider, just remove its key from .env.local.
 * The cascade automatically skips it and tries the next one.
 */

import { config } from "dotenv";
import { resolveGeminiModel } from "./models.ts";
config({ path: ".env.local" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AIMessage {
    role: "user" | "assistant";
    content: string;
}

export interface AIResponse {
    text: string;
    provider: string;
    model: string;
}

export interface AIRequestOptions {
    system?: string;
    maxTokens?: number;
}

// ─── Provider: Groq ───────────────────────────────────────────────────────────

async function callGroq(
    messages: AIMessage[],
    options: AIRequestOptions,
): Promise<AIResponse> {
    const { default: Groq } = await import("groq-sdk");
    const client = new Groq({ apiKey: process.env["GROQ_API_KEY"] });

    const groqMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

    if (options.system) {
        groqMessages.push({ role: "system", content: options.system });
    }
    for (const m of messages) {
        groqMessages.push({ role: m.role, content: m.content });
    }

    const response = await client.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: groqMessages,
        max_tokens: options.maxTokens ?? 2000,
        temperature: 0.3,
    });

    return {
        text: response.choices[0]?.message?.content ?? "",
        provider: "Groq",
        model: "openai/gpt-oss-120b",
    };
}

// ─── Provider: Google Gemini ──────────────────────────────────────────────────

async function callGemini(
    messages: AIMessage[],
    options: AIRequestOptions,
): Promise<AIResponse> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"]!);
    const modelName = resolveGeminiModel();

    const model = genAI.getGenerativeModel({
        model: modelName,
        ...(options.system ? { systemInstruction: options.system } : {}),
    });

    // Convert messages to Gemini format
    const history = messages.slice(0, -1).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
    }));

    const lastMessage = messages[messages.length - 1]?.content ?? "";

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage);

    return {
        text: result.response.text(),
        provider: "Gemini",
        model: modelName,
    };
}

// ─── Provider: Anthropic Claude ───────────────────────────────────────────────

async function callAnthropic(
    messages: AIMessage[],
    options: AIRequestOptions,
): Promise<AIResponse> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

    const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: options.maxTokens ?? 2000,
        ...(options.system ? { system: options.system } : {}),
        messages,
    });

    const text =
        response.content
            .filter((b) => b.type === "text")
            .map((b) => b.type === "text" ? b.text : "")
            .join("\n") ?? "";

    return {
        text,
        provider: "Anthropic",
        model: "claude-haiku-4-5",
    };
}

// ─── Fallback Cascade ─────────────────────────────────────────────────────────

type ProviderEntry = {
    name: string;
    keyEnv: string;
    call: (messages: AIMessage[], options: AIRequestOptions) => Promise<AIResponse>;
};

const PROVIDERS: ProviderEntry[] = [
    { name: "Groq",      keyEnv: "GROQ_API_KEY",      call: callGroq },
    { name: "Gemini",    keyEnv: "GEMINI_API_KEY",     call: callGemini },
    { name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY",  call: callAnthropic },
];

/**
 * Call the AI brain using the first available provider.
 * Automatically falls back if a provider has no key or throws an error.
 *
 * @example
 * const res = await callAI([{ role: "user", content: "Why am I broke?" }], {
 *   system: "You are a finance analyst."
 * });
 * console.log(`[${res.provider}] ${res.text}`);
 */
export async function callAI(
    messages: AIMessage[],
    options: AIRequestOptions = {},
): Promise<AIResponse> {
    const errors: string[] = [];
    let configuredProviderCount = 0;

    for (const provider of PROVIDERS) {
        // Skip if API key not configured
        if (!process.env[provider.keyEnv]) {
            console.log(`  ⚙  ${provider.name}: no key set, skipping.`);
            continue;
        }
        configuredProviderCount++;

        try {
            console.log(`  🧠 Calling ${provider.name}...`);
            const result = await provider.call(messages, options);
            console.log(`  ✅ ${provider.name} responded successfully.`);
            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${provider.name}: ${msg}`);
            console.warn(`  ⚠  ${provider.name} failed: ${msg} — trying next...`);
        }
    }

    if (configuredProviderCount === 0) {
        throw new Error("No AI provider is configured. Configure GROQ_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY.");
    }

    throw new Error(
        `All configured AI providers failed:\n${errors.map((e) => `  • ${e}`).join("\n")}\n\n` +
        "Provider credentials are present; review the provider errors above.",
    );
}

/**
 * Simple one-shot AI call: just pass a prompt string.
 */
export async function ask(
    prompt: string,
    systemPrompt?: string,
): Promise<AIResponse> {
    return callAI(
        [{ role: "user", content: prompt }],
        systemPrompt ? { system: systemPrompt } : {},
    );
}

/**
 * List which providers are currently active (have keys set).
 */
export function getActiveProviders(): string[] {
    return PROVIDERS
        .filter((p) => !!process.env[p.keyEnv])
        .map((p) => p.name);
}
