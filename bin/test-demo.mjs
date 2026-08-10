import {
    runMcpQuery,
    listMcpTools,
    closeMcpClient,
} from "../src/mcp/client.ts";
import { config } from "dotenv";

config({ path: ".env.local" });

console.log("============================================================");
console.log("📊 DEMO: COCKROACHDB MCP SERVER & HISTORICAL REASONING");
console.log("============================================================\n");

console.log("1. Connecting to CockroachDB MCP Server...");
const tools = await listMcpTools();
console.log(`✅ Connected! Exposed MCP Tools (${tools.length}):`);
console.log("   " + tools.map((t) => t.name).join(", "));

console.log("\n2. Inspecting CockroachDB Schema via MCP...");
const tables = await runMcpQuery(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
);
console.log("   Tables & Views found in DB:");
console.log(
    "   " +
        JSON.stringify(
            JSON.parse(tables.content).rows.map((r) => r.table_name),
        ),
);

console.log("\n3. MCP Query: Aggregated Spending Breakdown by Category");
const spending = await runMcpQuery(
    "SELECT category, count(*) AS txn_count, ROUND(sum(amount)::numeric, 2) AS total_spent_usd FROM spending_history GROUP BY category ORDER BY total_spent_usd DESC",
);
console.log(JSON.stringify(JSON.parse(spending.content).rows, null, 2));

console.log(
    "\n4. MCP Query: Detecting Top Spending Mistakes & Habit Anomalies",
);
const mistakes = await runMcpQuery(
    "SELECT date, merchant_name, transaction_name, amount FROM spending_history WHERE amount >= 50 OR merchant_name IN ('DoorDash', 'Uber Eats', 'Equinox') ORDER BY amount DESC",
);
console.log(JSON.stringify(JSON.parse(mistakes.content).rows, null, 2));

await closeMcpClient();
console.log("\n============================================================");
console.log("🎉 VERIFICATION PASSED: MCP Server is querying CockroachDB!");
console.log("============================================================");
