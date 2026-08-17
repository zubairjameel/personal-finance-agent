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

function buildSystemPrompt(userId: string): string {
    return `You are Kadmus, an autonomous financial intelligence sentinel and advisor with direct, real-time access to the user's CockroachDB financial memory through native Model Context Protocol (MCP) database tools.

## Who You Are:
- Name: Kadmus
- Role: 24/7 Personal Finance AI Sentinel & Chief Financial Advisor
- Memory Core: CockroachDB (distributed, resilient, persistent transactional database)
- Mission: Protect the user's financial wellbeing, catch dangerous spending patterns, audit anomalies, and provide honest, data-backed insights.

## CRITICAL — User Identity:
- The current user's ID is: '${userId}'
- ALWAYS filter every SQL query with: WHERE user_id = '${userId}'
- NEVER ask the user for their ID — you already have it above.
- Do NOT expose this UUID to the user in your response.

## How to Work with CockroachDB (MCP Tools):
- The default database is \`defaultdb\` (public schema).
- Primary Tables (always filter by user_id):
  • \`spending_history\` (id, user_id, amount, category, merchant_name, transaction_name, date, account_name)
  • \`income_history\` (id, user_id, amount, category, merchant_name, transaction_name, date, account_name)
  • \`anomalies\` (id, user_id, type, severity, title, description, amount, merchant_name, status, created_at)
  • \`accounts\` (id, user_id, name, type, subtype, currency)
  • \`transactions\` (id, account_id, user_id, date, merchant_name, name, amount, category_primary, pending)
- Use \`select_query\` to query transactions, anomalies, and balances with SQL.
- Always add \`LIMIT\` to SELECT queries.
- Formulate your diagnosis based ONLY on real queried data. Never hallucinate numbers or dates.

## Formatting Your Diagnosis (CRITICAL for Telegram readability):
Respond naturally and conversationally. Do NOT use markdown tables with vertical pipes | | (Telegram does not render tables). Instead, use clean bullet points:
- **The Verdict**: One direct, blunt summary of the financial reality.
- **The Evidence**: Bullet points with bold amounts and details:
  • **$500.00** — United Airlines (Travel, 2026-08-10)
  • **$5,850.00** — ACH Transfer (Transfer Out, 2026-08-11)
- **The Pattern**: Root behavioral habits driving the problem.
- **One Fix**: The single highest-leverage action the user should take right now.

Be sharp, empathetic, and strictly grounded in database evidence.`;
}

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
    userId: string,
): Promise<AgentResult> {
    const { default: Groq } = await import("groq-sdk");
    const client = new Groq({ apiKey: process.env["GROQ_API_KEY"] });
    const tools = await getMcpToolsForGroq();
    const SYSTEM_PROMPT = buildSystemPrompt(userId);

    const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];

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

    let lastError: Error | null = null;

    for (const modelName of GROQ_MODELS) {
        try {
            const messages: GroqMessage[] = [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: question },
            ];

            let toolCallCount = 0;
            let finalAnswer = "";
            const maxIter = 10;

            for (let i = 0; i < maxIter; i++) {
                const response = await client.chat.completions.create({
                    model: modelName,
                    messages,
                    tools,
                    tool_choice: "auto",
                    max_tokens: 2000,
                });

                const choice = response.choices[0];
                if (!choice) break;

                const msg = choice.message;
                if (msg.content) finalAnswer = msg.content;
                if (!msg.tool_calls || msg.tool_calls.length === 0) break;

                messages.push({
                    role: "assistant",
                    content: msg.content ?? "",
                    tool_calls: msg.tool_calls,
                });

                for (const tc of msg.tool_calls) {
                    toolCallCount++;
                    const toolName = tc.function.name;
                    const toolArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;

                    if (verbose) console.log(`  → [Groq/${modelName}] MCP Tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);

                    const result = await callMcpTool(toolName, toolArgs);
                    if (verbose) console.log(`    ↳ ${result.content.slice(0, 160)}${result.content.length > 160 ? "…" : ""}`);

                    messages.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: result.isError ? `Error: ${result.content}` : result.content,
                    });
                }
            }

            // If the loop exhausted without a text answer, force one synthesis call
            if (!finalAnswer && toolCallCount > 0) {
                messages.push({ role: "user", content: "Based on the database data you just retrieved, please now provide your complete financial diagnosis." });
                const synthRes = await client.chat.completions.create({
                    model: modelName,
                    messages,
                    max_tokens: 2000,
                    temperature: 0.3,
                });
                finalAnswer = synthRes.choices[0]?.message?.content ?? "";
            }

            return {
                answer: finalAnswer,
                provider: "Groq",
                model: modelName,
                toolCallCount,
            };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (verbose) console.warn(`  ⚠ Groq/${modelName} failed (${lastError.message.slice(0, 80)}) — trying next Groq model...`);
        }
    }

    throw lastError ?? new Error("All Groq models failed.");
}

// ─── Gemini Tool-Use Loop ─────────────────────────────────────────────────────

async function runWithGemini(
    question: string,
    verbose: boolean,
    userId: string,
): Promise<AgentResult> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"]!);
    const mcpTools = await getMcpToolsForGemini();
    const SYSTEM_PROMPT = buildSystemPrompt(userId);

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
    userId: string,
): Promise<AgentResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
    const tools = await getMcpToolsForAnthropic();
    const SYSTEM_PROMPT = buildSystemPrompt(userId);

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
    run: (question: string, verbose: boolean, userId: string) => Promise<AgentResult>;
};

const PROVIDERS: ProviderRunner[] = [
    { name: "Groq",      keyEnv: "GROQ_API_KEY",      run: runWithGroq },
    { name: "Gemini",    keyEnv: "GEMINI_API_KEY",     run: runWithGemini },
    { name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY",  run: runWithAnthropic },
];

import { decideMemoryAction, saveAgentMemory } from "./outcome-memory.ts";
import { getOrCreateUser } from "../db/index.ts";

/**
 * Run the full MCP financial reasoning agent using the first available provider.
 * Integrates CockroachDB Distributed Vector Memory with Outcome Verification:
 *   • Checks past outcomes for similar questions (REUSE vs ABSTAIN).
 *   • Persists new recommendations with 768-dim embeddings in CockroachDB.
 */
export async function runMcpAgent(
    question: string,
    options: { verbose?: boolean; bypassMemory?: boolean } = {},
): Promise<AgentResult> {
    const { verbose = true, bypassMemory = false } = options;

    let user: { id: string } | null = null;
    try {
        user = await getOrCreateUser();
    } catch {
        // Continue if DB user check fails
    }

    let memoryPrefix = "";

    // ── 1. Outcome-Verified Memory Check ────────────────────────────────────
    if (user && !bypassMemory) {
        try {
            const decision = await decideMemoryAction(user.id, question);

            if (verbose) {
                console.log(`\n🧠 CockroachDB Vector Memory: [${decision.action}] — ${decision.reason}`);
            }

            // Case A: REUSE verified successful precedent
            if (decision.action === "REUSE") {
                return {
                    answer: `♻️ **VERIFIED PRECEDENT REUSED FROM COCKROACHDB MEMORY**\n` +
                            `<i>(${decision.reason})</i>\n\n` +
                            decision.memory.recommendation,
                    provider: "CockroachDB Memory (Vector Search)",
                    model: "outcome-verified-reuse",
                    toolCallCount: 0,
                };
            }

            // Case B: ABSTAIN from repeating a failed/revoked recommendation
            if (decision.action === "ABSTAIN") {
                memoryPrefix = `⚠️ **PAST FAILURE PRECEDENT (CockroachDB Memory Audit):**\n` +
                               `<i>${decision.reason}</i>\n` +
                               `<i>Abstaining from repeating previous advice. Delivering a fresh, updated diagnosis below:</i>\n\n` +
                               `──────────────────────────────────────────────────\n\n`;
            }
        } catch (err) {
            if (verbose) console.warn(`  ⚠ Memory search skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // ── 2. Run Multi-Provider AI Brain with MCP Database Tools ─────────────
    const errors: string[] = [];

    for (const provider of PROVIDERS) {
        if (!process.env[provider.keyEnv]) {
            if (verbose) console.log(`  ⚙  ${provider.name}: no API key — skipping`);
            continue;
        }

        try {
            if (verbose) console.log(`\n🧠 Using ${provider.name} as AI brain...\n${"─".repeat(50)}`);
            const result = await provider.run(question, verbose, user?.id ?? "unknown");
            if (verbose) console.log(`\n✅ ${provider.name} completed (${result.toolCallCount} MCP tool calls)`);

            // ── 3. Persist new recommendation into CockroachDB Vector Memory ─
            if (user && result.answer) {
                try {
                    await saveAgentMemory(user.id, question, result.answer, "pending");
                    if (verbose) console.log(`💾 Saved recommendation & 768-dim vector embedding to CockroachDB 'agent_memory'`);
                } catch {
                    // ignore memory save error
                }
            }

            return {
                ...result,
                answer: memoryPrefix + result.answer,
            };
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
