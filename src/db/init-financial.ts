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

    // Strip line comments before splitting
    const cleanSql = rawSql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
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
