/**
 * src/mcp/client.ts
 *
 * Connects to the official CockroachDB MCP Server binary
 * (github.com/cockroachdb/cockroachdb-mcp-server v0.1.0) via stdio transport.
 *
 * Exposes dynamic tool listing and execution helpers for pure MCP usage.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import type Anthropic from "@anthropic-ai/sdk";

config({ path: ".env.local" });

const dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McpQueryResult {
    content: string;
    isError: boolean;
}

// ─── Singleton client ─────────────────────────────────────────────────────────

let _client: Client | null = null;

/** Absolute path to the pre-built binary in project bin/ */
function binaryPath(): string {
    const projectRoot = path.resolve(dirname, "..", "..");
    return path.join(projectRoot, "bin", "cockroachdb-mcp-server.exe");
}

/**
 * Lazily start the MCP server subprocess and return a connected client.
 * Reuses the existing process within the same Node.js process lifetime.
 */
export async function getMcpClient(): Promise<Client> {
    if (_client) return _client;

    const dbUrl = process.env["DATABASE_URL"];
    if (!dbUrl) {
        throw new Error(
            "DATABASE_URL is not set in .env.local — " +
                "cannot start cockroachdb-mcp-server",
        );
    }

    const isLocalInsecure =
        dbUrl.includes("sslmode=disable") ||
        dbUrl.includes("localhost") ||
        dbUrl.includes("127.0.0.1");

    const transport = new StdioClientTransport({
        command: binaryPath(),
        args: [], // The binary takes zero args — all config is via env vars
        env: {
            ...process.env,
            CRDB_DATABASE_URL: dbUrl,
            CRDB_MCP_ALLOW_INSECURE_DB: isLocalInsecure ? "true" : "false",
            CRDB_MCP_ENABLE_WRITE_QUERIES: "true",
            CRDB_MCP_ALLOW_PASSWORD_AUTH: "true",
            NO_COLOR: "1",
        } as Record<string, string>,
    });

    _client = new Client(
        { name: "personal-finance-agent", version: "1.0.0" },
        { capabilities: {} },
    );

    await _client.connect(transport);
    return _client;
}

/** Gracefully close the MCP subprocess. Call before process.exit(). */
export async function closeMcpClient(): Promise<void> {
    if (_client) {
        await _client.close();
        _client = null;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(
    content: Array<{ type: string; text?: string }>,
): string {
    return content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
}

// ─── Dynamic MCP API ─────────────────────────────────────────────────────────

/**
 * Dynamically fetch all available MCP tools from CockroachDB MCP server
 * and convert them to Anthropic SDK Tool format.
 */
export async function getMcpToolsForAnthropic(): Promise<Anthropic.Tool[]> {
    const client = await getMcpClient();
    const { tools } = await client.listTools();

    return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }));
}

/**
 * Call ANY tool dynamically on the CockroachDB MCP server by name.
 */
export async function callMcpTool(
    name: string,
    args: Record<string, unknown>,
): Promise<McpQueryResult> {
    const client = await getMcpClient();
    const result = await client.callTool({
        name,
        arguments: args,
    });
    return {
        content: extractText(
            result.content as Array<{ type: string; text?: string }>,
        ),
        isError: result.isError === true,
    };
}

/**
 * Execute a SELECT statement via the `select_query` MCP tool.
 */
export async function runMcpQuery(sql: string): Promise<McpQueryResult> {
    return callMcpTool("select_query", { query: sql });
}

/**
 * List all tools the running MCP server exposes.
 */
export async function listMcpTools(): Promise<
    Array<{ name: string; description?: string }>
> {
    const client = await getMcpClient();
    const { tools } = await client.listTools();
    return tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
    }));
}
