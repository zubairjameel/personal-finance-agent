import { initSchema, pool } from "./index.ts";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function initFinancialSchema() {
    const rawSql = await readFile(
        path.join(dirname, "financial-schema.sql"),
        "utf-8",
    );

    // Strip only full-line SQL comments (lines where -- is the first token).
    // Do NOT strip inline comments (e.g. column definitions that contain --)
    // because splitting on ; would corrupt those statements.
    const cleanSql = rawSql
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n");

    const statements = cleanSql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    for (const stmt of statements) {
        await pool.query(stmt);
    }
}

await initSchema();
console.log("Base schema applied.");
await initFinancialSchema();
console.log("Financial schema applied.");
await pool.end();
