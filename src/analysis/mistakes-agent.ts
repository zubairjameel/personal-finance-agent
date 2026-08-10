/**
 * src/analysis/mistakes-agent.ts
 *
 * "What financial mistakes did I make this year that explain why I'm broke?"
 *
 * This is an open-ended reasoning agent that:
 *   1. Connects to CockroachDB via the MCP server (no fixed queries)
 *   2. Lets Claude autonomously write and execute SQL to explore the data
 *   3. Synthesises a narrative answer grounded in real numbers
 *
 * It is completely separate from Serey's CLI agent — no shared tool arrays,
 * no shared session state, no shared prompts.
 *
 * Usage:
 *   npm run analysis -- "what financial mistakes did I make this year"
 *   npm run analysis -- "why am I always broke by the 15th?"
 */

import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { runMcpQuery, closeMcpClient, listMcpTools } from "../mcp/client.ts";
import { getOrCreateUser, pool } from "../db/index.ts";
import { fullSync } from "../mcp/sync.ts";

config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolInput {
    sql?: string;
    query?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are a sharp, honest personal finance analyst. You have direct access to the user's complete transaction history stored in CockroachDB. Your job is to answer open-ended financial questions by actually querying the data — not guessing.

## Database Schema

\`\`\`sql
-- Spending view (positive amounts = money out, excludes pending)
spending_history columns:
  id, account_id, user_id, date, year, month,
  merchant_name, transaction_name, amount, currency,
  category, category_detailed, channel,
  account_name, account_type

-- Income view (sign-flipped, income as positive values)
income_history columns:
  id, account_id, user_id, date, year, month,
  merchant_name, transaction_name, amount, currency,
  category, account_name

-- Raw tables (if you need pending or more detail)
transactions: id, account_id, user_id, date, authorized_date,
              merchant_name, name, amount, currency,
              category_primary, category_detailed, pending, channel
accounts: id, user_id, name, type, subtype, currency
\`\`\`

## Key facts
- Plaid sign convention (in raw \`transactions\`): **positive = money out, negative = money in**
- The \`spending_history\` and \`income_history\` views already handle the sign correctly
- The database may contain sandbox/test data from Plaid — treat it as real

## How to answer questions
1. Start by querying the available date range so you know what years/months are in the data
2. Write focused SQL queries to find the evidence for each part of your answer
3. Ground every claim in actual query results — no invented numbers
4. Be brutally honest about what the data shows
5. Quantify: exact dollar amounts, percentages, counts

## SQL style
- Use \`spending_history\` and \`income_history\` views wherever possible
- Always include a \`LIMIT\` clause (max 100 rows) unless you're doing an aggregate
- Use \`GROUP BY\`, \`ORDER BY\`, window functions freely — CockroachDB is PostgreSQL-compatible
- Format currency as: \`ROUND(amount::numeric, 2)\`
- Use \`CURRENT_DATE\` for today's date

## Response format
After your SQL exploration, deliver the answer as:
1. **The verdict** — one blunt sentence
2. **The evidence** — bullet points with specific numbers from the data
3. **The pattern** — what recurring behaviour explains it
4. **One actionable fix** — the single highest-leverage change

Keep it under 400 words. Be a financial truth-teller, not a cheerleader.`;

// ---------------------------------------------------------------------------
// MCP tool definitions for the Claude agent
// ---------------------------------------------------------------------------

const MCP_SQL_TOOLS: Anthropic.Tool[] = [
    {
        name: "query_financial_db",
        description:
            "Execute a SELECT statement against the user's CockroachDB financial " +
            "database using the select_query MCP tool. " +
            "Use this to explore transactions, spending patterns, income, and any other " +
            "data needed to answer the user's question. Returns query results as JSON rows.",
        input_schema: {
            type: "object" as const,
            properties: {
                sql: {
                    type: "string",
                    description:
                        "A valid CockroachDB SQL SELECT statement. Always include LIMIT.",
                },
            },
            required: ["sql"],
        },
    },
];

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

/**
 * Run a financial analysis question using Claude + MCP SQL access.
 * Claude autonomously writes queries and synthesises the answer.
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
            system: ANALYSIS_SYSTEM_PROMPT,
            tools: MCP_SQL_TOOLS,
            tool_choice: { type: "auto" },
            messages,
        });

        // Collect any text content
        const textBlocks = response.content.filter(
            (b): b is Anthropic.TextBlock => b.type === "text",
        );
        const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (textBlocks.length > 0) {
            finalAnswer = textBlocks.map((b) => b.text).join("\n");
        }

        // If stop_reason is end_turn or no tool calls, we're done
        if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
            break;
        }

        // Push the assistant message
        messages.push({ role: "assistant", content: response.content });

        // Execute each tool call and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
            if (toolUse.name === "query_financial_db") {
                const input = toolUse.input as ToolInput;
                const sql = input.sql ?? input.query ?? "";

                if (verbose) {
                    console.log(
                        `\n  → SQL: ${sql.slice(0, 120)}${sql.length > 120 ? "…" : ""}`,
                    );
                }

                const result = await runMcpQuery(sql);

                if (verbose && !result.isError) {
                    // Show a brief preview of results
                    const preview = result.content.slice(0, 200);
                    console.log(
                        `    ↳ ${preview}${result.content.length > 200 ? "…" : ""}`,
                    );
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
        }

        // Push tool results and loop
        messages.push({ role: "user", content: toolResults });
    }

    if (verbose) {
        console.log("\n" + "─".repeat(60));
        console.log(`\n📊 Analysis (${iterCount} queries):\n`);
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

    // Verify MCP connectivity first
    try {
        const tools = await listMcpTools();
        console.log(
            `✅ MCP server connected. Available tools: ${tools.map((t) => t.name).join(", ")}`,
        );
    } catch (err) {
        console.error("❌ Failed to connect to MCP server:", err);
        console.error(
            "\nMake sure cockroachdb-mcp-server is installed and DATABASE_URL is set.",
        );
        console.error(
            "Binary is at bin/cockroachdb-mcp-server.exe — make sure DATABASE_URL is set in .env.local.",
        );
        process.exit(1);
    }

    const user = await getOrCreateUser();

    const answer = await analyzeFinancialQuestion(question, {
        verbose: true,
        syncFirst: true, // sync Plaid → CockroachDB before querying
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
