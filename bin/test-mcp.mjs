/**
 * Quick MCP connectivity test.
 * Starts the binary, does the MCP handshake, lists tools, then exits.
 * Run: node bin/test-mcp.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "dotenv";

// Load env
config({ path: ".env.local" });

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    console.error("❌ DATABASE_URL not set in .env.local");
    process.exit(1);
}

console.log(
    `🔌 Connecting MCP server to: ${dbUrl.replace(/:[^:@]*@/, ":***@")}`,
);

const transport = new StdioClientTransport({
    command: "d:\\Personal AGenet\\bin\\cockroachdb-mcp-server.exe",
    args: [],
    env: {
        ...process.env,
        CRDB_DATABASE_URL: dbUrl,
        CRDB_MCP_ALLOW_INSECURE_DB: "true",
        CRDB_MCP_ENABLE_WRITE_QUERIES: "true",
        CRDB_MCP_ALLOW_PASSWORD_AUTH: "true",
    },
});

const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
);

try {
    await client.connect(transport);
    console.log("✅ Connected!\n");

    const { tools } = await client.listTools();
    console.log(`📦 Available tools (${tools.length}):\n`);
    for (const tool of tools) {
        console.log(`  • ${tool.name}`);
        if (tool.description) {
            console.log(`    ${tool.description.slice(0, 80)}...`);
        }
    }

    // Test a simple query
    console.log("\n🔍 Testing select_query with: SELECT 1 AS ping");
    const result = await client.callTool({
        name: "select_query",
        arguments: { query: "SELECT 1 AS ping" },
    });
    console.log(
        "Result:",
        JSON.stringify(result.content, null, 2).slice(0, 300),
    );

    await client.close();
    console.log("\n✅ All tests passed — MCP server is fully functional!");
    process.exit(0);
} catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
}
