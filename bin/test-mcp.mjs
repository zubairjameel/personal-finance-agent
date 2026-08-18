#!/usr/bin/env node
import { config } from "dotenv";
import {
    closeMcpClient,
    listMcpTools,
    runMcpQuery,
} from "../src/mcp/client.ts";

config({ path: ".env.local" });

try {
    const tools = await listMcpTools();
    console.log(`Connected to CockroachDB Managed MCP (${tools.length} tools).`);
    console.log(`Tools: ${tools.map((tool) => tool.name).join(", ")}`);

    const result = await runMcpQuery("SELECT 1 AS ping");
    if (result.isError) throw new Error("Managed MCP SELECT verification failed");
    console.log("Managed MCP read-only SELECT verification passed.");
} catch (error) {
    console.error(`Managed MCP verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    await closeMcpClient();
}
