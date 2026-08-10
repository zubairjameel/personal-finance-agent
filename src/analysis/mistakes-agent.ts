/**
 * src/analysis/mistakes-agent.ts
 *
 * "What financial mistakes did I make this year that explain why I'm broke?"
 *
 * Pure MCP Reasoning Agent:
 *   1. Dynamically fetches ALL available tools from cockroachdb-mcp-server via listTools()
 *   2. Passes the complete tool manifest directly to Anthropic Claude
 *   3. Claude autonomously decides at runtime which tool(s) to call (list_tables, get_table_schema, select_query, etc.)
 *   4. Synthesises a narrative answer grounded in real data
 *
 * Usage:
 *   npm run analysis -- "what financial mistakes did I make this year"
 */

import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import {
    getMcpToolsForAnthropic,
    callMcpTool,
    closeMcpClient,
    listMcpTools,
} from "../mcp/client.ts";
import { getOrCreateUser, pool } from "../db/index.ts";
import { fullSync } from "../mcp/sync.ts";

config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Pure MCP System Prompt (No Hardcoded Table/Column Names)
// ---------------------------------------------------------------------------

const PURE_MCP_SYSTEM_PROMPT = `You are a sharp, honest personal finance analyst. You have direct access to the user's CockroachDB cluster through a set of native Model Context Protocol (MCP) database tools.

Your job is to answer open-ended financial questions by dynamically discovering the database structure and querying the data.

## Workflow
1. **Discover**: Start by listing available tables in the database using \`list_tables\`.
2. **Inspect**: Use \`get_table_schema\` to inspect column names, data types, and views.
3. **Query**: Execute SQL queries using \`select_query\` to analyze spending, income, merchants, and habits.
4. **Synthesise**: Deliver a brutally honest, evidence-based answer grounded in exact query results.

## Key Rules
- Ground every claim in actual tool output — never invent numbers or table names.
- Always include a \`LIMIT\` clause in your SELECT statements.
- Format currency clearly (e.g. \`ROUND(amount::numeric, 2)\`).
- Deliver your final diagnosis as:
  1. **The Verdict** — one blunt sentence summary.
  2. **The Evidence** — bullet points with exact dollar amounts and counts.
  3. **The Pattern** — recurring behaviors that explain the situation.
  4. **One Actionable Fix** — the single highest-leverage change.

Keep it concise, honest, and direct.`;

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

/**
 * Run a financial analysis question using pure dynamic MCP tool discovery.
 * Claude receives the complete MCP tool catalog and chooses tools dynamically.
 */
export async function analyzeFinancialQuestion(
    question: string,
    options: {
        maxIterations?: number;
        verbose?: boolean;
        syncFirst?: boolean;
        userId?: string;
    } = {},
): Promise<string> {
    const {
        maxIterations = 15,
        verbose = true,
        syncFirst = false,
        userId,
    } = options;

    const client = new Anthropic({
        apiKey: process.env["ANTHROPIC_API_KEY"],
    });

    // Dynamically fetch ALL native tools from CockroachDB MCP Server
    const dynamicMcpTools = await getMcpToolsForAnthropic();

    if (verbose) {
        console.log(
            `\n🔌 Dynamically loaded ${dynamicMcpTools.length} tools from CockroachDB MCP Server`,
        );
    }

    // Optionally sync Plaid data first
    if (syncFirst && userId) {
        if (verbose) process.stdout.write("⟳  Syncing Plaid data… ");
        await fullSync(userId);
        if (verbose) console.log("done.\n");
    }

    if (verbose) {
        console.log(`\n🔍 Analysing: "${question}"\n`);
        console.log("─".repeat(60));
    }

    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: question },
    ];

    let iterCount = 0;
    let finalAnswer = "";

    while (iterCount < maxIterations) {
        iterCount++;

        const response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 2000,
            system: PURE_MCP_SYSTEM_PROMPT,
            tools: dynamicMcpTools, // Dynamic MCP tools array!
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

        if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
            break;
        }

        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
            const toolName = toolUse.name;
            const toolArgs = toolUse.input as Record<string, unknown>;

            if (verbose) {
                const argsSummary = JSON.stringify(toolArgs).slice(0, 100);
                console.log(`\n  → MCP Tool: ${toolName}(${argsSummary})`);
            }

            // Execute ANY tool dynamically on CockroachDB MCP Server
            const result = await callMcpTool(toolName, toolArgs);

            if (verbose && !result.isError) {
                const preview = result.content.slice(0, 180);
                console.log(`    ↳ ${preview}${result.content.length > 180 ? "…" : ""}`);
            }

            toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: result.isError
                    ? `Error: ${result.content}`
                    : result.content,
                is_error: result.isError,
            });
        }

        messages.push({ role: "user", content: toolResults });
    }

    if (verbose) {
        console.log("\n" + "─".repeat(60));
        console.log(`\n📊 Analysis complete (${iterCount} turns):\n`);
    }

    return finalAnswer;
}

// ---------------------------------------------------------------------------
// Standalone runner
// ---------------------------------------------------------------------------

async function main() {
    const question =
        process.argv.slice(2).join(" ") ||
        "What financial mistakes did I make this year that explain why I'm broke?";

    try {
        const tools = await listMcpTools();
        console.log(
            `✅ MCP server connected. Available tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`,
        );
    } catch (err) {
        console.error("❌ Failed to connect to MCP server:", err);
        console.error(
            "\nBinary is at bin/cockroachdb-mcp-server.exe — make sure DATABASE_URL is set in .env.local.",
        );
        process.exit(1);
    }

    const user = await getOrCreateUser();

    const answer = await analyzeFinancialQuestion(question, {
        verbose: true,
        syncFirst: false, // Use existing CockroachDB data
        userId: user.id,
    });

    console.log(answer);

    await closeMcpClient();
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
