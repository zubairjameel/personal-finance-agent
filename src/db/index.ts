import { config } from "dotenv";
import { readFile } from "fs/promises";
import path from "path";
import { Pool } from "pg";
import net from "net";
import { spawn } from "child_process";
import { existsSync } from "fs";
import os from "os";

config({ path: ".env.local" });

function checkPort(port = 26257): Promise<boolean> {
    return new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(500);
        s.on("connect", () => { s.destroy(); resolve(true); });
        s.on("timeout", () => { s.destroy(); resolve(false); });
        s.on("error", () => resolve(false));
        s.connect(port, "127.0.0.1");
    });
}

export async function ensureCockroachRunning(): Promise<void> {
    const isLocal = (process.env["DATABASE_URL"] ?? "").includes("localhost") || 
                    (process.env["DATABASE_URL"] ?? "").includes("127.0.0.1");
    if (!isLocal) return;

    if (await checkPort(26257)) return;

    const candidates = [
        path.join(os.homedir(), ".cockroachdb", "bin", "cockroach.exe"),
        path.join(os.homedir(), ".cockroachdb", "bin", "cockroach"),
        "D:\\cockroach-v24.3.11.windows-6.2-amd64\\cockroach-v24.3.11.windows-6.2-amd64\\cockroach.exe",
        "cockroach",
    ];

    const found = candidates.find((c) => existsSync(c));
    if (!found) return;

    spawn(found, [
        "start-single-node",
        "--insecure",
        "--listen-addr=localhost:26257",
        "--http-addr=localhost:8080",
        "--store=cockroach-data",
    ], { detached: true, stdio: "ignore" }).unref();

    for (let i = 0; i < 25; i++) {
        if (await checkPort(26257)) return;
        await new Promise((r) => setTimeout(r, 400));
    }
}

export const pool = new Pool({
    connectionString: process.env["DATABASE_URL"],
    application_name: "personal_finance_agent",
});

export async function initSchema() {
    await ensureCockroachRunning();
    const schema = await readFile(
        path.resolve(process.cwd(), "src", "db", "schema.sql"),
        "utf-8",
    );
    await pool.query(schema);
}

export interface Message {
    role: "user" | "assistant";
    content: string;
}

export interface ChatContext {
    messages: Message[];
}

export async function loadMessages(sessionId: string): Promise<Message[]> {
    const result = await pool.query<Message>(
        "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at ASC",
        [sessionId],
    );
    return result.rows;
}

export async function saveMessage(
    sessionId: string,
    role: Message["role"],
    content: string,
): Promise<void> {
    await pool.query(
        "INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)",
        [sessionId, role, content],
    );
}

export interface Session {
    id: string;
    created_at: string;
    resumed_at: string | null;
}

export async function loadSessions(userId: string): Promise<Session[]> {
    const sessions = await pool.query<Session>(
        "SELECT id, created_at, resumed_at FROM sessions WHERE user_id = ($1) ORDER BY created_at DESC",
        [userId],
    );
    return sessions.rows;
}

export async function createSession(userId: string): Promise<string> {
    const session = await pool.query<{ id: string }>(
        "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id",
        [userId],
    );
    return session.rows[0]!.id;
}

export async function resumeSession(
    sessionId: string,
    timestamp: string,
): Promise<void> {
    await pool.query("UPDATE sessions SET resumed_at = $1 WHERE id = $2", [
        timestamp,
        sessionId,
    ]);
}

export interface User {
    id: string;
}

export async function getOrCreateUser(): Promise<User> {
    await ensureCockroachRunning();
    const existing = await pool.query<User>(
        "SELECT id FROM users ORDER BY id ASC LIMIT 1",
    );
    if (existing.rows[0]) {
        return existing.rows[0];
    }
    const inserted = await pool.query<User>(
        "INSERT INTO users DEFAULT VALUES RETURNING id",
    );
    return inserted.rows[0]!;
}
