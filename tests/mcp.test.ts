import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COCKROACH_MCP_URL, resolveMcpTransportConfig } from "../src/mcp/client.ts";

test("Cloud MCP defaults to official endpoint and sends both required headers", () => {
    const config = resolveMcpTransportConfig({
        COCKROACH_MCP_API_KEY: "test-key",
        COCKROACH_MCP_CLUSTER_ID: "test-cluster",
    });
    assert.equal(config.kind, "http");
    if (config.kind !== "http") return;
    assert.equal(config.url, DEFAULT_COCKROACH_MCP_URL);
    assert.equal(config.headers.Authorization, "Bearer test-key");
    assert.equal(config.headers["mcp-cluster-id"], "test-cluster");
});

test("Cloud MCP requires cluster scoping", () => {
    assert.throws(
        () => resolveMcpTransportConfig({ COCKROACH_MCP_API_KEY: "test-key" }),
        /COCKROACH_MCP_CLUSTER_ID/,
    );
});
