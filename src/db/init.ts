import { initSchema, pool } from "./index.ts";

await initSchema();
console.log("Schema applied.");
await pool.end();
