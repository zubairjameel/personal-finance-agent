/**
 * src/ai/mcp-agent.ts
 *
 * Unified MCP Reasoning Agent with Multi-Provider Fallback.
 *
 * Runs the full tool-use loop (discover → query → synthesise) using
 * whichever AI provider is available, in this order:
 *
 *   1. Groq      (GROQ_API_KEY)   — free, 14k req/day, Llama 3.3 70B
 *   2. Gemini    (GEMINI_API_KEY) — free, 1500 req/day, Gemini 1.5 Flash
 *   3. Anthropic (ANTHROPIC_API_KEY) — paid fallback, Claude Haiku
 *
 * All three providers support full tool/function calling.
 * The CockroachDB MCP server works identically regardless of AI provider.
 */

import { config } from "dotenv";
import {
    getMcpToolsForAnthropic,
    getMcpToolsForGroq,
    getMcpToolsForGemini,
    callMcpTool,
} from "../mcp/client.ts";

config({ path: ".env.local" });

const SYSTEM_PROMPT = `You are Kadmus, an autonomous financial intelligence sentinel and advisor with direct, real-time access to the user's CockroachDB financial memory through native Model Context Protocol (MCP) database tools.

## Who You Are:
- Name: Kadmus
- Role: 24/7 Personal Finance AI Sentinel & Chief Financial Advisor
- Memory Core: CockroachDB (distributed, resilient, persistent transactional database)
- Mission: Protect the user's financial wellbeing, catch dangerous spending patterns, audit anomalies, and provide honest, data-backed insights.

## How to Work with CockroachDB (MCP Tools):
- The default database is \`defaultdb\` (public schema).
- Primary Tables:
  • \`spending_history\` (id, user_id, amount, category, merchant_name, transaction_name, date, account_name)
  • \`anomalies\` (id, user_id, type, severity, title, description, amount, merchant_name, status, created_at)
  • \`bank_accounts\` (id, user_id, name, type, balance_current, balance_available)
- Use \`select_query\` to query transactions, anomalies, and balances with SQL.
- Always add \`LIMIT\` to SELECT queries.
- Formulate your diagnosis based ONLY on real queried data. Never hallucinate numbers or dates.

## Formatting Your Diagnosis:
Structure your response cleanly using markdown:
- 🏛️ **The Verdict**: One direct, blunt summary of the financial reality.
- 🔍 **The Evidence**: Bullet points detailing exact numbers, amounts, dates, and merchants retrieved from the database.
- ⚠️ **The Pattern**: Root behavioral habits (e.g. impulse purchases, subscription leaks, food delivery surges).
- 💡 **Actionable Remedy**: The single highest-leverage financial action the user should take right now.

Be sharp, transparent, empathetic yet direct, and strictly grounded in database evidence.`;

export interface AgentResult {
    answer: string;
    provider: string;
    model: string;
    toolCallCount: number;
}

// ─── Groq Tool-Use Loop ───────────────────────────────────────────────────────

async function runWithGroq(
    question: string,
    verbose: boolean,
): Promise<AgentResult> {
    const { default: Groq } = await import("groq-sdk");
    const client = new Groq({ apiKey: process.env["GROQ_API_KEY"] });
    const tools = await getMcpToolsForGroq();

    type GroqMessage = {
        role: "system" | "user" | "assistant" | "tool";
        content: string;
        tool_call_id?: string;
        tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
        }>;
    };

    const messages: GroqMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
    ];

    let toolCallCount = 0;
    let finalAnswer = "";
    const maxIter = 15;

    for (let i = 0; i < maxIter; i++) {
        const response = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages,
            tools,
            tool_choice: "auto",
            max_tokens: 2000,
        });

        const choice = response.choices[0];
        if (!choice) break;

        const msg = choice.message;

        // Collect any text
        if (msg.content) finalAnswer = msg.content;

        // If no tool calls, we are done
        if (!msg.tool_calls || msg.tool_calls.length === 0) break;

        // Add assistant message with tool calls
        messages.push({
            role: "assistant",
            content: msg.content ?? "",
            tool_calls: msg.tool_calls,
        });

        // Execute each tool call
        for (const tc of msg.tool_calls) {
            toolCallCount++;
            const toolName = tc.function.name;
            const toolArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;

            if (verbose) console.log(`  → [Groq] MCP Tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);

            const result = await callMcpTool(toolName, toolArgs);

            if (verbose) console.log(`    ↳ ${result.content.slice(0, 160)}${result.content.length > 160 ? "…" : ""}`);

            messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result.isError ? `Error: ${result.content}` : result.content,
            });
        }
    }

    return {
        answer: finalAnswer,
        provider: "Groq",
        model: "llama-3.3-70b-versatile",
        toolCallCount,
    };
}

// ─── Gemini Tool-Use Loop ─────────────────────────────────────────────────────

async function runWithGemini(
    question: string,
    verbose: boolean,
): Promise<AgentResult> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"]!);
    const mcpTools = await getMcpToolsForGemini();

    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: mcpTools }],
    });

    const chat = model.startChat();
    let toolCallCount = 0;
    let finalAnswer = "";
    const maxIter = 15;
    let currentMessage = question;

    for (let i = 0; i < maxIter; i++) {
        const result = await chat.sendMessage(currentMessage);
        const response = result.response;
        const parts = response.candidates?.[0]?.content?.parts ?? [];

        // Collect text parts
        const textParts = parts.filter((p) => "text" in p && p.text);
        if (textParts.length > 0) {
            finalAnswer = textParts.map((p) => ("text" in p ? p.text : "")).join("\n");
        }

        // Find function call parts
        const fnCalls = parts.filter((p) => "functionCall" in p && p.functionCall);
        if (fnCalls.length === 0) break;

        // Execute each function call and collect responses
        const functionResponses = [];
        for (const part of fnCalls) {
            if (!("functionCall" in part) || !part.functionCall) continue;
            const { name, args } = part.functionCall;
            toolCallCount++;

            if (verbose) console.log(`  → [Gemini] MCP Tool: ${name}(${JSON.stringify(args).slice(0, 80)})`);

            const mcpResult = await callMcpTool(name, args as Record<string, unknown>);

            if (verbose) console.log(`    ↳ ${mcpResult.content.slice(0, 160)}${mcpResult.content.length > 160 ? "…" : ""}`);

            functionResponses.push({
                functionResponse: {
                    name,
                    response: {
                        result: mcpResult.isError
                            ? { error: mcpResult.content }
                            : { data: mcpResult.content },
                    },
                },
            });
        }

        // Send function results back
        const followUp = await chat.sendMessage(functionResponses);
        const followParts = followUp.response.candidates?.[0]?.content?.parts ?? [];
        const followText = followParts.filter((p) => "text" in p && p.text);
        if (followText.length > 0) {
            finalAnswer = followText.map((p) => ("text" in p ? p.text : "")).join("\n");
        }

        // Check if more tool calls needed
        const moreFnCalls = followParts.filter((p) => "functionCall" in p && p.functionCall);
        if (moreFnCalls.length === 0) break;
        currentMessage = "";
    }

    return {
        answer: finalAnswer,
        provider: "Gemini",
        model: "gemini-1.5-flash",
        toolCallCount,
    };
}

// ─── Anthropic Tool-Use Loop ──────────────────────────────────────────────────

async function runWithAnthropic(
    question: string,
    verbose: boolean,
): Promise<AgentResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
    const tools = await getMcpToolsForAnthropic();

    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: question },
    ];

    let toolCallCount = 0;
    let finalAnswer = "";
    const maxIter = 15;

    for (let i = 0; i < maxIter; i++) {
        const response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 2000,
            system: SYSTEM_PROMPT,
            tools,
            tool_choice: { type: "auto" },
            messages,
        });

        const textBlocks = response.content.filter(
            (b): b is Anthropic.TextBlock => b.type === "text",
        );
        const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (textBlocks.length > 0) {
            finalAnswer = textBlocks.map((b) => b.text).join("\n");
        }

        if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) break;

        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUseBlocks) {
            toolCallCount++;
            const toolArgs = tu.input as Record<string, unknown>;

            if (verbose) console.log(`  → [Anthropic] MCP Tool: ${tu.name}(${JSON.stringify(toolArgs).slice(0, 80)})`);

            const result = await callMcpTool(tu.name, toolArgs);

            if (verbose) console.log(`    ↳ ${result.content.slice(0, 160)}${result.content.length > 160 ? "…" : ""}`);

            toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: result.isError ? `Error: ${result.content}` : result.content,
                is_error: result.isError,
            });
        }

        messages.push({ role: "user", content: toolResults });
    }

    return {
        answer: finalAnswer,
        provider: "Anthropic",
        model: "claude-haiku-4-5",
        toolCallCount,
    };
}

// ─── Unified Fallback Cascade ─────────────────────────────────────────────────

type ProviderRunner = {
    name: string;
    keyEnv: string;
    run: (question: string, verbose: boolean) => Promise<AgentResult>;
};

const PROVIDERS: ProviderRunner[] = [
    { name: "Groq",      keyEnv: "GROQ_API_KEY",      run: runWithGroq },
    { name: "Gemini",    keyEnv: "GEMINI_API_KEY",     run: runWithGemini },
    { name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY",  run: runWithAnthropic },
];

/**
 * Run the full MCP financial reasoning agent using the first available provider.
 * Automatically falls back if a provider has no key or throws an error.
 */
export async function runMcpAgent(
    question: string,
    options: { verbose?: boolean } = {},
): Promise<AgentResult> {
    const { verbose = true } = options;
    const errors: string[] = [];

    for (const provider of PROVIDERS) {
        if (!process.env[provider.keyEnv]) {
            if (verbose) console.log(`  ⚙  ${provider.name}: no API key — skipping`);
            continue;
        }

        try {
            if (verbose) console.log(`\n🧠 Using ${provider.name} as AI brain...\n${"─".repeat(50)}`);
            const result = await provider.run(question, verbose);
            if (verbose) console.log(`\n✅ ${provider.name} completed (${result.toolCallCount} MCP tool calls)`);
            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${provider.name}: ${msg}`);
            console.warn(`  ⚠  ${provider.name} failed: ${msg.slice(0, 100)} — trying next provider...`);
        }
    }

    throw new Error(
        `All AI providers failed:\n${errors.map((e) => `  • ${e}`).join("\n")}\n\n` +
        `Set at least one key in .env.local:\n  GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY`,
    );
}
