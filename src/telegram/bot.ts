/**
 * src/telegram/bot.ts
 *
 * Kadmus Telegram Bot & Alert Dispatcher.
 *
 * Provides two capabilities:
 *   1. Proactive Alerts: Dispatches queued anomalies from CockroachDB to user's Telegram.
 *   2. Interactive Chat: Allows users to talk with Kadmus directly from Telegram.
 *
 * Usage:
 *   npm run telegram          ← starts standalone Telegram polling bot
 */

import { config } from "dotenv";
import { getPendingAnomalies, markAnomaliesNotified, DetectedAnomaly } from "../agent/anomaly-detector.ts";
import { getOrCreateUser, pool } from "../db/index.ts";
import { runMcpAgent } from "../ai/mcp-agent.ts";

config({ path: ".env.local" });

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message via Telegram Bot API using native fetch.
 */
export async function sendTelegramMessage(
    text: string,
    chatId: string | number = CHAT_ID!,
    parseMode: "HTML" | "Markdown" = "HTML",
): Promise<boolean> {
    if (!BOT_TOKEN || !chatId) {
        return false;
    }

    try {
        const res = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: parseMode,
                disable_web_page_preview: true,
            }),
        });

        const data = (await res.json()) as { ok: boolean; description?: string };
        if (!data.ok) {
            console.error(`[Telegram] Failed to send message: ${data.description}`);
            return false;
        }
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Telegram] Network error sending message: ${msg}`);
        return false;
    }
}

/**
 * Format a detected anomaly into a clean, rich Telegram message.
 */
function formatAnomalyMessage(a: DetectedAnomaly): string {
    const icon = a.severity === "CRITICAL" ? "🚨" : a.severity === "HIGH" ? "⚠️" : "ℹ️";
    const amountStr = a.amount ? `$${Number(a.amount).toFixed(2)}` : "N/A";
    const merchant = a.merchantName ? `<b>Merchant:</b> ${escapeHtml(a.merchantName)}\n` : "";

    return (
        `${icon} <b>KADMUS ALERT: [${a.severity}]</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>${escapeHtml(a.title)}</b>\n` +
        `💰 <b>Amount:</b> ${amountStr}\n` +
        merchant +
        `\n📝 <i>${escapeHtml(a.description)}</i>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🛡️ <i>Kadmus 24/7 Financial Sentinel</i>`
    );
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Push all pending anomalies in CockroachDB to the user's Telegram.
 * Marks them as 'notified' once delivered.
 */
export async function pushPendingAnomalyAlerts(userId: string): Promise<number> {
    if (!BOT_TOKEN || !CHAT_ID) {
        return 0;
    }

    const pending = await getPendingAnomalies(userId);
    if (pending.length === 0) return 0;

    let sentCount = 0;
    const notifiedIds: string[] = [];

    for (const anomaly of pending) {
        const msg = formatAnomalyMessage(anomaly);
        const sent = await sendTelegramMessage(msg, CHAT_ID);
        if (sent) {
            sentCount++;
            if (anomaly.id) notifiedIds.push(anomaly.id);
        }
    }

    if (notifiedIds.length > 0) {
        await markAnomaliesNotified(notifiedIds);
    }

    return sentCount;
}

// ─── Interactive Telegram Polling Bot ────────────────────────────────────────

let lastUpdateId = 0;
let isPolling = false;

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        chat: { id: number; first_name?: string; username?: string };
        from?: { id: number; first_name?: string };
        text?: string;
        date: number;
    };
}

async function handleTelegramMessage(update: TelegramUpdate) {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const userText = msg.text.trim();
    const userName = msg.from?.first_name ?? "there";

    console.log(`[Telegram] Message from ${userName} (${chatId}): "${userText}"`);

    // Command: /start or /help
    if (userText === "/start" || userText === "/help") {
        const welcome =
            `👋 <b>Hello ${escapeHtml(userName)}! I am Kadmus.</b>\n\n` +
            `I am your <b>24/7 Autonomous Financial Sentinel</b> with persistent CockroachDB memory.\n\n` +
            `<b>What I do:</b>\n` +
            `• 🔄 Auto-sync bank data via Plaid\n` +
            `• 🚨 Proactively alert you on spending spikes & duplicate charges\n` +
            `• 💬 Answer any financial questions using real database data\n\n` +
            `<b>Commands:</b>\n` +
            `• /status — Check database & system health\n` +
            `• /alerts — Review recent financial anomalies\n` +
            `• <i>Or simply type any question, e.g.:</i>\n` +
            `  <i>"What did I spend on food this month?"</i>\n` +
            `  <i>"Explain why I'm broke"</i>`;

        await sendTelegramMessage(welcome, chatId);
        return;
    }

    // Command: /status
    if (userText === "/status") {
        try {
            const user = await getOrCreateUser();
            const txnCount = await pool.query<{ count: string }>(
                `SELECT count(*) FROM spending_history WHERE user_id = $1`,
                [user.id],
            );
            const anomalyCount = await pool.query<{ count: string }>(
                `SELECT count(*) FROM anomalies WHERE user_id = $1`,
                [user.id],
            );

            const statusMsg =
                `🛡️ <b>KADMUS SYSTEM STATUS</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🟢 <b>Database:</b> CockroachDB (Connected)\n` +
                `👤 <b>User Identity:</b> <code>${user.id.slice(0, 8)}...</code>\n` +
                `📊 <b>Stored Transactions:</b> ${txnCount.rows[0]?.count ?? "0"}\n` +
                `🚨 <b>Total Detected Anomalies:</b> ${anomalyCount.rows[0]?.count ?? "0"}\n` +
                `🧠 <b>AI Brain:</b> Multi-Provider Cascade (Groq / Gemini / Anthropic)\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `<i>24/7 Heartbeat Daemon is active.</i>`;

            await sendTelegramMessage(statusMsg, chatId);
        } catch (err) {
            const errorStr = err instanceof Error ? err.message : String(err);
            await sendTelegramMessage(`❌ Error checking status: ${escapeHtml(errorStr)}`, chatId);
        }
        return;
    }

    // Command: /alerts
    if (userText === "/alerts") {
        try {
            const user = await getOrCreateUser();
            const recent = await pool.query<{
                title: string;
                amount: number;
                severity: string;
                created_at: string;
            }>(
                `SELECT title, amount, severity, created_at FROM anomalies WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
                [user.id],
            );

            if (recent.rows.length === 0) {
                await sendTelegramMessage(`✅ <b>No anomalies detected!</b> Your finances are clean.`, chatId);
                return;
            }

            let alertText = `🚨 <b>Recent Financial Anomalies (Last 5):</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            for (const r of recent.rows) {
                const icon = r.severity === "CRITICAL" ? "🔴" : "🟡";
                alertText += `${icon} <b>[${r.severity}]</b> ${escapeHtml(r.title)} ($${Number(r.amount).toFixed(2)})\n`;
            }
            await sendTelegramMessage(alertText, chatId);
        } catch (err) {
            const errorStr = err instanceof Error ? err.message : String(err);
            await sendTelegramMessage(`❌ Error fetching alerts: ${escapeHtml(errorStr)}`, chatId);
        }
        return;
    }

    // Default: Run Kadmus AI Reasoning Agent on the user's question
    await sendTelegramMessage("🔍 <i>Kadmus is querying CockroachDB and analyzing your financial memory...</i>", chatId);

    try {
        const result = await runMcpAgent(userText, { verbose: false });
        const reply =
            `🏛️ <b>KADMUS DIAGNOSIS</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${escapeHtml(result.answer)}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🧠 <i>Powered by ${result.provider} (${result.model})</i>`;

        await sendTelegramMessage(reply, chatId);
    } catch (err) {
        const errorStr = err instanceof Error ? err.message : String(err);
        await sendTelegramMessage(`⚠️ <b>Kadmus Analysis Error:</b>\n${escapeHtml(errorStr)}`, chatId);
    }
}

/**
 * Start long-polling loop for Telegram updates.
 */
export async function startTelegramBot(): Promise<void> {
    if (!BOT_TOKEN) {
        console.error("❌ TELEGRAM_BOT_TOKEN is not set in .env.local — cannot start Telegram bot.");
        return;
    }

    console.log("🤖 Starting Kadmus Telegram Bot polling...");
    isPolling = true;

    // Send a startup greeting if CHAT_ID is configured
    if (CHAT_ID) {
        await sendTelegramMessage(
            "🛡️ <b>Kadmus Sentinel Activated</b>\n" +
            "<i>24/7 Autonomous Financial Guardian is now online and connected.</i>",
            CHAT_ID,
        );
    }

    while (isPolling) {
        try {
            const url = `${TELEGRAM_API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
            const res = await fetch(url);
            const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };

            if (data.ok && Array.isArray(data.result)) {
                for (const update of data.result) {
                    lastUpdateId = Math.max(lastUpdateId, update.update_id);
                    await handleTelegramMessage(update);
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Telegram Polling Error] ${msg}`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}

// Standalone runner if executed directly
if (process.argv[1]?.includes("bot.ts") || process.argv[1]?.includes("bot.js")) {
    startTelegramBot().catch((err) => {
        console.error("Fatal Telegram bot error:", err);
        process.exit(1);
    });
}
