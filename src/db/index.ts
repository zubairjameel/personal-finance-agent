import { config } from "dotenv";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

config({ path: ".env.local" });

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
    connectionString: process.env["DATABASE_URL"],
    application_name: "personal_finance_agent",
});

export async function initSchema() {
    const schema = await readFile(path.join(dirname, "schema.sql"), "utf-8");
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
    const existing = await pool.query<User>("SELECT id FROM users LIMIT 1");
    if (existing.rows[0]) {
        return existing.rows[0];
    }
    const inserted = await pool.query<User>(
        "INSERT INTO users DEFAULT VALUES RETURNING id",
    );
    return inserted.rows[0]!;
}
