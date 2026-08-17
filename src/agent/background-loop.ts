/// <reference types="node" />

/**
 * src/agent/background-loop.ts
 *
 * OpenClaw-Style Autonomous Background Heartbeat Daemon.
 *
 * This is the always-on autonomous brain of the finance agent.
 * It does NOT wait for user input — it wakes up on a heartbeat timer,
 * checks CockroachDB for new financial anomalies, and queues alerts.
 *
 * Architecture (OpenClaw pattern):
 *   ┌─────────────────────────────────────────────────┐
 *   │              HEARTBEAT DAEMON                   │
 *   │  Every N seconds:                               │
 *   │  1. Sync Plaid → CockroachDB (if token set)     │
 *   │  2. Run anomaly detection engine                 │
 *   │  3. Write new anomalies → CockroachDB            │
 *   │  4. Print alerts (Telegram bot picks these up)   │
 *   └─────────────────────────────────────────────────┘
 *
 * Usage:
 *   npm run background               ← single pass, then exits
 *   npm run background:watch         ← runs every 60s until Ctrl+C
 *   npm run background:watch -- --interval=30  ← custom interval
 */

import { config } from "dotenv";
import { getOrCreateUser, pool } from "../db/index.ts";
import { fullSync } from "../mcp/sync.ts";
import { detectAnomalies, getPendingAnomalies } from "./anomaly-detector.ts";

config({ path: ".env.local" });

// ─── ANSI colour helpers ────────────────────────────────────────────────────
const c = {
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    console.log(`${c.dim(`[${ts}]`)} ${msg}`);
}

function banner(msg: string) {
    console.log(c.cyan("━".repeat(60)));
    console.log(c.bold(`  ${msg}`));
    console.log(c.cyan("━".repeat(60)));
}

// ─── Heartbeat cycle ────────────────────────────────────────────────────────

export interface CycleResult {
    cycleNumber: number;
    timestamp: string;
    plaidSynced: boolean;
    newAnomalies: number;
    pendingAlerts: number;
    errors: string[];
}

let cycleCount = 0;

/**
 * Run one full heartbeat cycle:
 * 1. Sync Plaid bank data into CockroachDB
 * 2. Run anomaly detection over stored transactions
 * 3. Log pending alerts to console (Telegram bot will pick these up)
 */
export async function runHeartbeatCycle(): Promise<CycleResult> {
    cycleCount++;
    const result: CycleResult = {
        cycleNumber: cycleCount,
        timestamp: new Date().toISOString(),
        plaidSynced: false,
        newAnomalies: 0,
        pendingAlerts: 0,
        errors: [],
    };

    banner(`💓 HEARTBEAT #${cycleCount} — Autonomous Finance Agent`);

    // ── Step 1: Get or create the agent's user identity ───────────────────
    let userId: string;
    try {
        const user = await getOrCreateUser();
        userId = user.id;
        log(`${c.blue("👤")} Agent identity: ${c.dim(userId)}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Identity error: ${msg}`);
        log(c.red(`❌ Failed to get user identity: ${msg}`));
        return result;
    }

    // ── Step 2: Sync Plaid transactions → CockroachDB ─────────────────────
    if (process.env["PLAID_SANDBOX_ACCESS_TOKEN"]) {
        process.stdout.write(
            `${c.dim(`[${new Date().toLocaleTimeString()}]`)} ${c.blue("🔄")} Syncing Plaid transactions → CockroachDB... `,
        );
        try {
            const syncRes = await fullSync(userId);
            const total = Object.values(syncRes.stats).reduce(
                (sum, s) => sum + s.added + s.modified,
                0,
            );
            console.log(
                c.green(
                    `✓ ${syncRes.accounts.length} account(s), ${total} transaction(s) synced`,
                ),
            );
            result.plaidSynced = true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(c.yellow(`⚠ Skipped (${msg})`));
            result.errors.push(`Plaid sync: ${msg}`);
        }
    } else {
        log(
            c.dim(
                "ℹ  PLAID_SANDBOX_ACCESS_TOKEN not set — using existing CockroachDB data",
            ),
        );
    }

    // ── Step 3: Run Anomaly Detection engine ──────────────────────────────
    process.stdout.write(
        `${c.dim(`[${new Date().toLocaleTimeString()}]`)} ${c.blue("🔍")} Running Anomaly Detection engine... `,
    );
    try {
        const newAnomalies = await detectAnomalies(userId);
        result.newAnomalies = newAnomalies.length;
        console.log(
            c.green(
                `✓ ${newAnomalies.length} new anomaly(ies) detected & saved`,
            ),
        );

        if (newAnomalies.length > 0) {
            console.log();
            for (const a of newAnomalies) {
                const severity =
                    a.severity === "CRITICAL"
                        ? c.red(`[${a.severity}]`)
                        : a.severity === "HIGH"
                          ? c.yellow(`[${a.severity}]`)
                          : c.dim(`[${a.severity}]`);
                log(`  🚨 ${severity} ${c.bold(a.title)}`);
                log(`     ${c.dim(a.description)}`);
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(c.red(`❌ Failed (${msg})`));
        result.errors.push(`Anomaly detection: ${msg}`);
    }

    // ── Step 4: Dispatch pending alerts to Telegram ───────────────────────
    try {
        const pending = await getPendingAnomalies(userId);
        result.pendingAlerts = pending.length;

        console.log();
        if (pending.length > 0) {
            log(
                c.bold(
                    `📬 ${pending.length} alert(s) queued in CockroachDB:`,
                ),
            );
            for (const a of pending) {
                const sev =
                    a.severity === "CRITICAL"
                        ? c.red(a.severity)
                        : c.yellow(a.severity);
                log(`  • [${sev}] ${a.title}`);
            }

            // Dispatch alerts if Telegram credentials configured
            if (process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]) {
                const { pushPendingAnomalyAlerts } = await import("../telegram/bot.ts");
                process.stdout.write(`  📨 Dispatching alerts to Telegram... `);
                const sent = await pushPendingAnomalyAlerts(userId);
                console.log(c.green(`✓ ${sent} alert(s) delivered to Telegram chat.`));
            } else {
                log(c.dim(`  ℹ Set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID in .env.local to receive push alerts on your phone.`));
            }
        } else {
            log(c.green("✅ All clear — no pending anomalies in queue"));
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Pending alerts dispatch: ${msg}`);
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log();
    log(
        c.dim(
            `Cycle #${cycleCount} complete. ` +
                `New: ${result.newAnomalies} | Pending: ${result.pendingAlerts} | ` +
                `Errors: ${result.errors.length}`,
        ),
    );
    console.log();

    return result;
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function setupGracefulShutdown(intervalId?: ReturnType<typeof setInterval>) {
    const shutdown = async (signal: string) => {
        console.log(
            `\n${c.yellow(`⚠  Received ${signal} — shutting down gracefully...`)}`,
        );
        if (intervalId) clearInterval(intervalId);
        try {
            await pool.end();
            log(c.green("✓ Database pool closed"));
        } catch {
            // ignore
        }
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// ─── Main entrypoint ────────────────────────────────────────────────────────

async function main() {
    // Parse --interval=N flag (default 60 seconds)
    const intervalArg = process.argv
        .find((a) => a.startsWith("--interval="))
        ?.split("=")[1];
    const intervalSeconds = Math.max(10, Number(intervalArg ?? "60") || 60);
    const isWatchMode =
        process.argv.includes("--watch") ||
        process.env["BACKGROUND_WATCH"] === "true";

    console.log();
    banner("🤖 OPENCLAW AUTONOMOUS FINANCE AGENT — HEARTBEAT DAEMON");
    console.log();

    if (isWatchMode) {
        log(
            c.cyan(
                `Watch mode ON — heartbeat every ${intervalSeconds}s. Press Ctrl+C to stop.`,
            ),
        );
        console.log();

        // Run immediately on startup
        await runHeartbeatCycle();

        // Then repeat on interval
        const intervalId = setInterval(
            () => {
                runHeartbeatCycle().catch((err) => {
                    console.error(
                        c.red("💥 Unhandled error in heartbeat cycle:"),
                        err,
                    );
                });
            },
            intervalSeconds * 1000,
        );

        setupGracefulShutdown(intervalId);
        // Keep process alive
    } else {
        // Single pass mode
        log(c.dim("Single-pass mode. Use --watch for continuous heartbeat."));
        console.log();
        await runHeartbeatCycle();
        await pool.end();
        process.exit(0);
    }
}

// ── Always run — this file is always invoked directly via npm scripts ────────
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(c.red("💥 Fatal error in background daemon:"), err);
        pool.end().finally(() => process.exit(1));
    });
}