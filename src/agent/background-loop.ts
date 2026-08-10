/**
 * src/agent/background-loop.ts
 *
 * OpenClaw-Style Autonomous Background Worker.
 *
 * Runs autonomously in the background without user prompting.
 * 1. Syncs Plaid transactions to CockroachDB
 * 2. Runs the Anomaly Detection engine
 * 3. Queues alerts in CockroachDB `anomalies` table for Telegram bot delivery
 *
 * Usage:
 *   npm run background             (runs once and exits - single pass)
 *   npm run background -- --watch  (runs continuously every 60 seconds)
 */

import { config } from "dotenv";
import { getOrCreateUser, pool } from "../db/index.ts";
import { fullSync } from "../mcp/sync.ts";
import {
    detectAnomalies,
    getPendingAnomalies,
} from "./anomaly-detector.ts";

config({ path: ".env.local" });

const ansi = {
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

/**
 * Execute one full cycle of the background agent loop.
 */
export async function runBackgroundCycle(options: { verbose?: boolean } = {}) {
    const { verbose = true } = options;
    const timestamp = new Date().toLocaleTimeString();

    if (verbose) {
        console.log(`\n${ansi.bold(`[${timestamp}] 🔄 Running Autonomous Background Agent Cycle...`)}`);
    }

    const user = await getOrCreateUser();

    // 1. Sync Plaid data if tokens exist
    if (process.env["PLAID_SANDBOX_ACCESS_TOKEN"]) {
        try {
            if (verbose) process.stdout.write("  ⟳  Syncing Plaid bank transactions... ");
            const syncRes = await fullSync(user.id);
            if (verbose) console.log(ansi.green(`Done (${syncRes.accounts.length} account(s) synced).`));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (verbose) console.log(ansi.yellow(`Skipped Plaid sync (${msg}).`));
        }
    } else {
        if (verbose) console.log(ansi.dim("  ℹ  Plaid tokens not set — analyzing existing CockroachDB data."));
    }

    // 2. Run Anomaly Detection Engine
    if (verbose) process.stdout.write("  🔍 Running Anomaly Detection engine... ");
    const newAnomalies = await detectAnomalies(user.id);
    if (verbose) console.log(ansi.green(`Done (${newAnomalies.length} new anomaly(ies) queued).`));

    // 3. Print Pending Alerts
    const pending = await getPendingAnomalies(user.id);

    if (pending.length > 0) {
        console.log(`\n  ${ansi.bold(`🚨 PENDING ALERTS QUEUED FOR TELEGRAM (${pending.length}):`)}`);
        for (const a of pending) {
            const color = a.severity === "CRITICAL" ? ansi.red : ansi.yellow;
            console.log(`    • ${color(`[${a.severity}]`)} ${ansi.bold(a.title)}`);
            console.log(`      ${ansi.dim(a.description)}`);
        }
    } else {
        console.log(ansi.dim("  ✅ No pending anomalies — all financial metrics normal."));
    }

    if (verbose) {
        console.log(ansi.dim("  Cycle complete.\n"));
    }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    const isWatchMode = process.argv.includes("--watch");
    const intervalSeconds = 60;

    console.log("============================================================");
    console.log("🤖 OPENCLAW AUTONOMOUS BACKGROUND AGENT");
    console.log("============================================================\n");

    if (isWatchMode) {
        console.log(`Running in WATCH mode (cycling every ${intervalSeconds} seconds). Press Ctrl+C to exit.\n`);
        
        await runBackgroundCycle({ verbose: true });
        
        setInterval(async () => {
            await runBackgroundCycle({ verbose: true });
        }, intervalSeconds * 1000);
    } else {
        await runBackgroundCycle({ verbose: true });
        await pool.end();
        process.exit(0);
    }
}

// Run if called directly
if (process.argv[1]?.endsWith("background-loop.ts")) {
    main().catch((err) => {
        console.error("Fatal error in background loop:", err);
        process.exit(1);
    });
}
