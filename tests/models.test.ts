import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GEMINI_MODEL, resolveGeminiModel } from "../src/ai/models.ts";
import { SYSTEM_PROMPT } from "../src/ai/mcp-agent.ts";

test("Gemini defaults to a supported function-calling model and allows override", () => {
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.6-flash");
    assert.equal(resolveGeminiModel({}), "gemini-3.6-flash");
    assert.equal(resolveGeminiModel({ GEMINI_MODEL: " gemini-3.5-flash " }), "gemini-3.5-flash");
});

test("MCP schema guidance names real tables and requires discovery", () => {
    assert.match(SYSTEM_PROMPT, /`accounts`/);
    assert.match(SYSTEM_PROMPT, /`list_tables`/);
    assert.match(SYSTEM_PROMPT, /`get_table_schema`/);
    assert.doesNotMatch(SYSTEM_PROMPT, /bank_accounts/);
});
