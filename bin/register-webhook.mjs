#!/usr/bin/env node
import { config } from "dotenv";
config({ path: ".env.local" });

const webhookUrl = process.argv[2];
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!webhookUrl || !token || !secret) {
    console.error("Usage: npm run telegram:webhook -- <https-webhook-url>");
    console.error("Configure TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.local first.");
    process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret, drop_pending_updates: false }),
});
const result = await response.json();
if (!response.ok || !result.ok) {
    console.error(`Webhook registration failed (HTTP ${response.status}).`);
    process.exit(1);
}
console.log("Telegram webhook registered successfully.");
