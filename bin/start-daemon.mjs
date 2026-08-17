#!/usr/bin/env node
/**
 * bin/start-daemon.mjs
 *
 * OpenClaw-Style Full Daemon Starter.
 *
 * ONE command to start everything:
 *   npm run daemon
 *
 * What it does automatically:
 *   1. Finds CockroachDB binary on this machine
 *   2. Checks if CockroachDB is already running
 *   3. Starts CockroachDB if not running (hidden window)
 *   4. Waits until DB is ready to accept connections
 *   5. Starts the heartbeat agent loop
 *
 * No manual steps. No open terminal windows.
 * Ctrl+C stops everything cleanly.
 */

import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { config } from "dotenv";
import net from "net";
import path from "path";
import os from "os";

config({ path: ".env.local" });

// ─── ANSI colours ────────────────────────────────────────────────────────────
const c = {
    bold:   (s) => `\x1b[1m${s}\x1b[0m`,
    dim:    (s) => `\x1b[2m${s}\x1b[0m`,
    cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
    green:  (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red:    (s) => `\x1b[31m${s}\x1b[0m`,
};

function log(msg) { console.log(`${c.dim(new Date().toLocaleTimeString())}  ${msg}`); }
function banner(msg) {
    console.log(c.cyan("═".repeat(60)));
    console.log(c.bold(`  ${msg}`));
    console.log(c.cyan("═".repeat(60)));
}

// ─── Find CockroachDB binary ─────────────────────────────────────────────────

const COCKROACH_CANDIDATES = [
    // Standard install via cockroach CLI tool
    path.join(os.homedir(), ".cockroachdb", "bin", "cockroach.exe"),
    path.join(os.homedir(), ".cockroachdb", "bin", "cockroach"),
    // D drive common locations (Windows)
    "D:\\cockroach-v24.3.11.windows-6.2-amd64\\cockroach-v24.3.11.windows-6.2-amd64\\cockroach.exe",
    "D:\\cockroach-v24.3.10.windows-6.2-amd64\\cockroach-v24.3.10.windows-6.2-amd64\\cockroach.exe",
    // System PATH (Linux/Mac)
    "cockroach",
];

function findCockroach() {
    for (const candidate of COCKROACH_CANDIDATES) {
        try {
            if (existsSync(candidate)) return candidate;
            // Try PATH
            if (!candidate.includes("\\") && !candidate.includes("/")) {
                execSync(`${candidate} version`, { stdio: "ignore" });
                return candidate;
            }
        } catch { /* not found here */ }
    }
    return null;
}

// ─── Check if port 26257 is already open ────────────────────────────────────

function isPortOpen(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on("connect", () => { socket.destroy(); resolve(true); });
        socket.on("timeout", () => { socket.destroy(); resolve(false); });
        socket.on("error", () => resolve(false));
        socket.connect(port, host);
    });
}

// ─── Wait for CockroachDB to be ready ───────────────────────────────────────

async function waitForCockroach(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isPortOpen(26257)) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

// ─── Start CockroachDB ───────────────────────────────────────────────────────

let cockroachProcess = null;

function startCockroach(binary) {
    log(c.cyan(`Starting CockroachDB: ${binary}`));

    cockroachProcess = spawn(binary, [
        "start-single-node",
        "--insecure",
        "--listen-addr=localhost:26257",
        "--http-addr=localhost:8080",
        "--store=cockroach-data",
    ], {
        detached: false,   // dies with this process (clean)
        stdio: "ignore",   // suppress CockroachDB logs
    });

    cockroachProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
            log(c.red(`CockroachDB exited with code ${code}`));
        }
    });

    cockroachProcess.on("error", (err) => {
        log(c.red(`CockroachDB failed to start: ${err.message}`));
    });
}

// ─── Start heartbeat agent ────────────────────────────────────────────────────

let agentProcess = null;

function startAgent(intervalSeconds) {
    log(c.cyan(`Starting heartbeat agent (every ${intervalSeconds}s)...`));

    agentProcess = spawn(process.execPath, [
        "--experimental-strip-types",
        "src/agent/background-loop.ts",
        "--watch",
        `--interval=${intervalSeconds}`,
    ], {
        stdio: "inherit",   // show heartbeat output in this terminal
        env: process.env,
    });

    agentProcess.on("exit", (code) => {
        log(c.yellow(`Agent process exited (code ${code})`));
    });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
    console.log(`\n${c.yellow(`⚠  ${signal} received — shutting down...`)}`);
    if (agentProcess) { agentProcess.kill("SIGTERM"); log("✓ Agent stopped"); }
    if (cockroachProcess) { cockroachProcess.kill("SIGTERM"); log("✓ CockroachDB stopped"); }
    process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const intervalSeconds = Number(
        process.argv.find((a) => a.startsWith("--interval="))?.split("=")[1] ?? "60"
    );

    console.log();
    banner("🤖 OPENCLAW FINANCE AGENT — FULL DAEMON STARTUP");
    console.log();

    // Step 1: Check if CockroachDB already running
    const alreadyRunning = await isPortOpen(26257);

    if (alreadyRunning) {
        log(c.green("✓ CockroachDB already running on port 26257"));
    } else {
        // Step 2: Find binary
        const binary = findCockroach();
        if (!binary) {
            console.error(c.red(`
❌ CockroachDB not found on this machine.

Install it from: https://www.cockroachlabs.com/docs/stable/install-cockroachdb-windows
Or run: curl https://binaries.cockroachdb.com/cockroach-v24.3.11.windows-6.2-amd64.zip -o cockroach.zip
`));
            process.exit(1);
        }

        // Step 3: Start it
        log(`Found CockroachDB at: ${c.dim(binary)}`);
        startCockroach(binary);

        // Step 4: Wait for it to be ready
        process.stdout.write(`${c.dim(new Date().toLocaleTimeString())}  Waiting for CockroachDB to be ready`);
        const ready = await waitForCockroach(30000);
        console.log();

        if (!ready) {
            console.error(c.red("❌ CockroachDB did not start in time. Check binary path."));
            process.exit(1);
        }
        log(c.green("✓ CockroachDB is ready"));
    }

    // Step 4.5: Auto-apply database schemas if needed
    try {
        log(c.dim("Checking & ensuring database schemas..."));
        execSync(`node --experimental-strip-types src/db/init-financial.ts`, { stdio: "ignore" });
        log(c.green("✓ Database schemas verified"));
    } catch (err) {
        log(c.yellow(`⚠ Schema init note: ${err.message}`));
    }

    console.log();
    log(c.green(`✓ All systems ready. Heartbeat starts now.`));
    log(c.dim(`  Interval: every ${intervalSeconds}s | Press Ctrl+C to stop everything`));
    console.log();

    // Step 5: Start heartbeat agent
    startAgent(intervalSeconds);
}

main().catch((err) => {
    console.error(c.red("💥 Fatal error:"), err);
    process.exit(1);
});
