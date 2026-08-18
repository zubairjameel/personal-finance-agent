import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("financial schema creates a user-prefixed L2 vector index", async () => {
    const sql = await readFile("src/db/financial-schema.sql", "utf8");
    assert.match(sql, /CREATE VECTOR INDEX IF NOT EXISTS idx_memory_user_embedding\s+ON agent_memory \(user_id, embedding vector_l2_ops\)/i);
});
