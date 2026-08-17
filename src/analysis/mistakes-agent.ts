/**
 * src/analysis/mistakes-agent.ts
 *
 * "What financial mistakes did I make this year that explain why I'm broke?"
 *
 * Runs via the full multi-provider MCP reasoning agent:
 *   Groq → Gemini → Anthropic (tries each in order, skips missing keys)
 *
 * Usage:
 *   npm run analysis -- "what financial mistakes did I make this year"
 */

import { config } from "dotenv";
import {
    callMcpTool,
    closeMcpClient,
    listMcpTools,
} from "../mcp/client.ts";
import { getOrCreateUser, pool } from "../db/index.ts";
import { runMcpAgent } from "../ai/mcp-agent.ts";
import { getActiveProviders } from "../ai/provider.ts";

config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Standalone runner
// ---------------------------------------------------------------------------

async function main() {
    const question =
        process.argv.slice(2).join(" ") ||
        "What financial mistakes did I make this year that explain why I'm broke?";

    // Show which providers are available
    const active = getActiveProviders();
    console.log(
        `\n🧠 Active AI providers (fallback order): ${active.join(" → ") || "none — set at least one key in .env.local"}`,
    );

    // Verify MCP server is reachable before burning AI tokens
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

    // Ensure user identity exists
    await getOrCreateUser();

    console.log(`\n🔍 Analysing: "${question}"\n`);
    console.log("─".repeat(60));

    // Run using the multi-provider cascade (Groq → Gemini → Anthropic)
    // Whichever key you have set will be used automatically.
    const result = await runMcpAgent(question, { verbose: true });

    console.log("\n" + "═".repeat(60));
    console.log(
        `\n🏛️  KADMUS FINANCIAL DIAGNOSIS (Powered by ${result.provider} / ${result.model}):\n`,
    );
    console.log(result.answer);
    console.log("\n" + "═".repeat(60));

    await closeMcpClient();
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
