/**
 * src/mcp/client.ts
 *
 * Connects to CockroachDB Cloud Managed MCP over HTTP in production.
 * An explicit stdio command remains available for local development only.
 *
 * Exposes dynamic tool listing and execution helpers for pure MCP usage.
 * Supports converting MCP tools to Anthropic, Groq, and Gemini formats.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "dotenv";
import type Anthropic from "@anthropic-ai/sdk";

config({ path: ".env.local" });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McpQueryResult {
    content: string;
    isError: boolean;
}

export const DEFAULT_COCKROACH_MCP_URL = "https://cockroachlabs.cloud/mcp";

export type McpTransportConfig =
    | { kind: "http"; url: string; headers: Record<string, string> }
    | { kind: "stdio"; command: string; databaseUrl: string };

export function resolveMcpTransportConfig(
    environment: NodeJS.ProcessEnv = process.env,
): McpTransportConfig {
    const command = environment["COCKROACH_MCP_STDIO_COMMAND"];
    if (command) {
        const databaseUrl = environment["DATABASE_URL"];
        if (!databaseUrl) throw new Error("DATABASE_URL is required for local MCP stdio transport");
        return { kind: "stdio", command, databaseUrl };
    }

    const apiKey = environment["COCKROACH_MCP_API_KEY"];
    const clusterId = environment["COCKROACH_MCP_CLUSTER_ID"];
    if (!apiKey) throw new Error("COCKROACH_MCP_API_KEY is required for Cloud MCP");
    if (!clusterId) throw new Error("COCKROACH_MCP_CLUSTER_ID is required for Cloud MCP");
    return {
        kind: "http",
        url: environment["COCKROACH_MCP_URL"] ?? DEFAULT_COCKROACH_MCP_URL,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "mcp-cluster-id": clusterId,
        },
    };
}

// ─── Singleton client ─────────────────────────────────────────────────────────

let _client: Client | null = null;

import { ensureCockroachRunning } from "../db/index.ts";

/**
 * Lazily start the MCP server subprocess and return a connected client.
 * Reuses the existing process within the same Node.js process lifetime.
 */
export async function getMcpClient(): Promise<Client> {
    if (_client) return _client;

    const transportConfig = resolveMcpTransportConfig();
    let transport: StreamableHTTPClientTransport | StdioClientTransport;

    if (transportConfig.kind === "http") {
        transport = new StreamableHTTPClientTransport(new URL(transportConfig.url), {
            requestInit: {
                headers: transportConfig.headers,
            },
        });
    } else {
        await ensureCockroachRunning();
        const isLocalInsecure = transportConfig.databaseUrl.includes("sslmode=disable");
        transport = new StdioClientTransport({
            command: transportConfig.command,
            args: [],
            env: {
                ...process.env,
                CRDB_DATABASE_URL: transportConfig.databaseUrl,
                CRDB_MCP_ALLOW_INSECURE_DB: isLocalInsecure ? "true" : "false",
                CRDB_MCP_ENABLE_WRITE_QUERIES:
                    process.env["CRDB_ALLOW_WRITES"] === "true" ? "true" : "false",
                CRDB_MCP_ALLOW_PASSWORD_AUTH: "true",
                NO_COLOR: "1",
            } as Record<string, string>,
        });
    }

    _client = new Client(
        { name: "personal-finance-agent", version: "1.0.0" },
        { capabilities: {} },
    );

    await _client.connect(transport as Parameters<Client["connect"]>[0]);
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

// ─── Dynamic MCP API — Multi-Provider Tool Converters ────────────────────────

/**
 * Fetch all MCP tools and convert to Anthropic SDK format.
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

function sanitizeSchemaForGemini(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object") {
        return { type: "OBJECT", properties: {} };
    }
    const r = raw as Record<string, unknown>;
    const clean: Record<string, unknown> = {};

    if (typeof r["type"] === "string") {
        clean["type"] = (r["type"] as string).toUpperCase();
    } else if (Array.isArray(r["type"])) {
        const types = r["type"] as string[];
        const main = types.find((t) => t !== "null") ?? "string";
        clean["type"] = main.toUpperCase();
        clean["nullable"] = true;
    } else {
        clean["type"] = "OBJECT";
    }

    if (r["description"]) clean["description"] = r["description"];
    if (Array.isArray(r["required"])) clean["required"] = r["required"];
    if (Array.isArray(r["enum"])) clean["enum"] = r["enum"];

    if (r["properties"] && typeof r["properties"] === "object") {
        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r["properties"] as Record<string, unknown>)) {
            props[k] = sanitizeSchemaForGemini(v);
        }
        clean["properties"] = props;
    }

    if (r["items"] && typeof r["items"] === "object") {
        clean["items"] = sanitizeSchemaForGemini(r["items"]);
    }

    return clean;
}

/**
 * Fetch all MCP tools and convert to OpenAI-compatible format (used by Groq).
 * Groq uses the same function calling format as OpenAI.
 */
export async function getMcpToolsForGroq(): Promise<
    Array<{
        type: "function";
        function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        };
    }>
> {
    const client = await getMcpClient();
    const { tools } = await client.listTools();
    return tools.map((t) => ({
        type: "function" as const,
        function: {
            name: t.name,
            description: t.description ?? "",
            parameters: (t.inputSchema as Record<string, unknown>) ?? {
                type: "object",
                properties: {},
            },
        },
    }));
}

/**
 * Fetch all MCP tools and convert to Google Gemini functionDeclarations format.
 */
export async function getMcpToolsForGemini(): Promise<
    Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    }>
> {
    const client = await getMcpClient();
    const { tools } = await client.listTools();
    return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: sanitizeSchemaForGemini(t.inputSchema),
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
