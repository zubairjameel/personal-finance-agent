/**
 * src/mcp/client.ts
 *
 * Connects to the official CockroachDB MCP Server binary
 * (github.com/cockroachdb/cockroachdb-mcp-server v0.1.0) via stdio transport.
 *
 * ──────────────────────────────────────────────────────────
 * VERIFIED from bin/README.md — exact tool names:
 *
 * READ (always on):
 *   select_query       – SELECT statements (auto-LIMIT 100 if omitted)
 *   list_databases     – list all databases
 *   list_tables        – tables in a database (requires: database)
 *   get_table_schema   – CREATE TABLE ddl (requires: database, table)
 *   explain_query      – EXPLAIN plan without executing
 *   show_statement     – SHOW commands (SCHEMAS, INDEXES, REGIONS, JOBS…)
 *   get_cluster        – cluster identity + version
 *   list_sql_users     – SQL users
 *   list_cluster_nodes – nodes with address/liveness
 *   show_running_queries – in-flight statements
 *
 * WRITE (only when CRDB_MCP_ENABLE_WRITE_QUERIES=true):
 *   create_database    – create a database (requires: name)
 *   create_table       – CREATE TABLE (requires: statement)
 *   insert_rows        – INSERT (requires: statement)
 *   update_rows        – UPDATE … WHERE … (requires: statement)
 *   delete_rows        – DELETE … WHERE … (requires: statement)
 *
 * VERIFIED env vars (from README):
 *   CRDB_DATABASE_URL         – full libpq connection string (preferred)
 *   CRDB_MCP_ALLOW_INSECURE_DB  – required for sslmode=disable (local dev)
 *   CRDB_MCP_ENABLE_WRITE_QUERIES – gate for write tools (default: false)
 *   CRDB_MCP_ALLOW_PASSWORD_AUTH  – allow password in URL (default: false)
 * ──────────────────────────────────────────────────────────
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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
            // Use CRDB_DATABASE_URL (the canonical env var per README)
            CRDB_DATABASE_URL: dbUrl,
            // Required for local insecure clusters (sslmode=disable)
            CRDB_MCP_ALLOW_INSECURE_DB: isLocalInsecure ? "true" : "false",
            // Enable write tools — needed by the sync path
            CRDB_MCP_ENABLE_WRITE_QUERIES: "true",
            // Allow password auth (needed if URL contains a password)
            CRDB_MCP_ALLOW_PASSWORD_AUTH: "true",
            // Suppress color / ANSI codes in output
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

function extractText(content: Array<{ type: string; text?: string }>): string {
    return content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute a SELECT statement via the `select_query` MCP tool.
 * A LIMIT of 100 is automatically appended by the server if omitted.
 */
export async function runMcpQuery(sql: string): Promise<McpQueryResult> {
    const client = await getMcpClient();
    const result = await client.callTool({
        name: "select_query",
        arguments: { query: sql },
    });
    return {
        content: extractText(
            result.content as Array<{ type: string; text?: string }>,
        ),
        isError: result.isError === true,
    };
}

/**
 * Get the CREATE TABLE DDL for a table via `get_table_schema`.
 */
export async function getMcpTableSchema(
    database: string,
    table: string,
    schema = "public",
): Promise<McpQueryResult> {
    const client = await getMcpClient();
    const result = await client.callTool({
        name: "get_table_schema",
        arguments: { database, table, schema },
    });
    return {
        content: extractText(
            result.content as Array<{ type: string; text?: string }>,
        ),
        isError: result.isError === true,
    };
}

/**
 * List all tools the running MCP server exposes.
 * Useful to verify connectivity and confirm tool availability.
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
