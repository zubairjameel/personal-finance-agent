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
import { getPendingAnomalies, markAnomaliesNotified, type DetectedAnomaly } from "../agent/anomaly-detector.ts";
import { getOrCreateUser, pool } from "../db/index.ts";
import { runMcpAgent } from "../ai/mcp-agent.ts";

config({ path: ".env.local" });

const botToken = () => process.env["TELEGRAM_BOT_TOKEN"];
const chatId = () => process.env["TELEGRAM_CHAT_ID"];
const telegramApiBase = () => `https://api.telegram.org/bot${botToken()}`;

/**
 * Send a message via Telegram Bot API using native fetch.
 */
export async function sendTelegramMessage(
    text: string,
    targetChatId: string | number = chatId()!,
    parseMode: "HTML" | "Markdown" = "HTML",
): Promise<boolean> {
    if (!botToken() || !targetChatId) {
        return false;
    }

    try {
        const res = await fetch(`${telegramApiBase()}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: targetChatId,
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

function markdownToTelegramHtml(markdown: string): string {
    let html = escapeHtml(markdown);
    // Convert bold **text** or __text__ -> <b>text</b>
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    html = html.replace(/__(.+?)__/g, "<b>$1</b>");
    // Convert italic *text* or _text_ -> <i>text</i>
    html = html.replace(/(?<![a-zA-Z0-9])\*([^*]+?)\*(?![a-zA-Z0-9])/g, "<i>$1</i>");
    html = html.replace(/(?<![a-zA-Z0-9])_([^_]+?)_(?![a-zA-Z0-9])/g, "<i>$1</i>");
    // Convert inline code `code` -> <code>code</code>
    html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");
    return html;
}

/**
 * Push all pending anomalies in CockroachDB to the user's Telegram.
 * Marks them as 'notified' once delivered.
 */
export async function pushPendingAnomalyAlerts(userId: string): Promise<number> {
    if (!botToken() || !chatId()) {
        return 0;
    }

    const pending = await getPendingAnomalies(userId);
    if (pending.length === 0) return 0;

    let sentCount = 0;
    const notifiedIds: string[] = [];

    for (const anomaly of pending) {
        const msg = formatAnomalyMessage(anomaly);
        const sent = await sendTelegramMessage(msg, chatId());
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

export interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        chat: { id: number; first_name?: string; username?: string };
        from?: { id: number; first_name?: string };
        text?: string;
        date: number;
    };
}

export interface TelegramUpdateDependencies {
    sendMessage: typeof sendTelegramMessage;
    getUser: typeof getOrCreateUser;
    query: typeof pool.query;
    runAgent: typeof runMcpAgent;
    getAllowedChatId: () => string | undefined;
}

export function parseTelegramCommand(text: string): string | null {
    const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(text.trim());
    return match?.[1]?.toLowerCase() ?? null;
}

const defaultUpdateDependencies: TelegramUpdateDependencies = {
    sendMessage: sendTelegramMessage,
    getUser: getOrCreateUser,
    query: pool.query.bind(pool),
    runAgent: runMcpAgent,
    getAllowedChatId: chatId,
};

export function createTelegramUpdateHandler(
    dependencies: TelegramUpdateDependencies = defaultUpdateDependencies,
) {
    return async (update: TelegramUpdate): Promise<void> => {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const allowedChatId = dependencies.getAllowedChatId()?.trim();
    if (!allowedChatId || String(chatId) !== allowedChatId) {
        console.warn(`[Telegram] Ignoring unauthorized update ${update.update_id}`);
        return;
    }

    const userText = msg.text.trim();
    const command = parseTelegramCommand(userText);
    const userName = msg.from?.first_name ?? "there";

    console.log(`[Telegram] Processing update ${update.update_id}`);

    // Command: /start or /help
    if (command === "start" || command === "help") {
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

        await dependencies.sendMessage(welcome, chatId);
        return;
    }

    // Command: /status
    if (command === "status") {
        try {
            const user = await dependencies.getUser();
            const txnCount = await dependencies.query<{ count: string }>(
                `SELECT count(*) FROM spending_history WHERE user_id = $1`,
                [user.id],
            );
            const anomalyCount = await dependencies.query<{ count: string }>(
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

            await dependencies.sendMessage(statusMsg, chatId);
        } catch (err) {
            const errorStr = err instanceof Error ? err.message : String(err);
            await dependencies.sendMessage(`❌ Error checking status: ${escapeHtml(errorStr)}`, chatId);
        }
        return;
    }

    // Command: /alerts
    if (command === "alerts") {
        try {
            const user = await dependencies.getUser();
            const recent = await dependencies.query<{
                title: string;
                amount: number;
                severity: string;
                created_at: string;
            }>(
                `SELECT title, amount, severity, created_at FROM anomalies WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
                [user.id],
            );

            if (recent.rows.length === 0) {
                await dependencies.sendMessage(`✅ <b>No anomalies detected!</b> Your finances are clean.`, chatId);
                return;
            }

            let alertText = `🚨 <b>Recent Financial Anomalies (Last 5):</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            for (const r of recent.rows) {
                const icon = r.severity === "CRITICAL" ? "🔴" : "🟡";
                alertText += `${icon} <b>[${r.severity}]</b> ${escapeHtml(r.title)} ($${Number(r.amount).toFixed(2)})\n`;
            }
            await dependencies.sendMessage(alertText, chatId);
        } catch (err) {
            const errorStr = err instanceof Error ? err.message : String(err);
            await dependencies.sendMessage(`❌ Error fetching alerts: ${escapeHtml(errorStr)}`, chatId);
        }
        return;
    }

    // Default: Run Kadmus AI Reasoning Agent on the user's question
    try {
        const result = await runMcpAgent(userText, { verbose: false });

        if (!result.answer || result.answer.trim() === "") {
            await sendTelegramMessage("I couldn't find enough data to answer that. Try asking about your spending, income, or anomalies.", chatId);
            return;
        }

        await sendTelegramMessage(markdownToTelegramHtml(result.answer), chatId);
    } catch (err) {
        const errorStr = err instanceof Error ? err.message : String(err);
        await sendTelegramMessage(`Something went wrong while analyzing your finances. Please try again in a moment.`, chatId);
        console.error(`[Kadmus] Agent error:`, errorStr);
    }
    };
}

export const handleTelegramUpdate = createTelegramUpdateHandler();

/**
 * Start long-polling loop for Telegram updates.
 */
export async function startTelegramBot(): Promise<void> {
    if (!botToken()) {
        console.error("❌ TELEGRAM_BOT_TOKEN is not set in .env.local — cannot start Telegram bot.");
        return;
    }

    console.log("🤖 Starting Kadmus Telegram Bot polling...");
    isPolling = true;

    // Send a startup greeting if CHAT_ID is configured
    if (chatId()) {
        await sendTelegramMessage(
            "🛡️ <b>Kadmus Activated</b>\n" +
            "<i>24/7 Autonomous Financial Guardian is now online and connected.</i>",
            chatId(),
        );
    }

    while (isPolling) {
        try {
            const url = `${telegramApiBase()}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
            const res = await fetch(url);
            const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };

            if (data.ok && Array.isArray(data.result)) {
                for (const update of data.result) {
                    lastUpdateId = Math.max(lastUpdateId, update.update_id);
                    await handleTelegramUpdate(update);
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
const invokedFile = process.argv[1]?.replaceAll("\\", "/");
const isDirectExecution =
    invokedFile?.endsWith("/bot.ts") === true ||
    invokedFile?.endsWith("/bot.js") === true;

if (isDirectExecution) {
    startTelegramBot().catch((err) => {
        console.error("Fatal Telegram bot error:", err);
        process.exit(1);
    });
}
