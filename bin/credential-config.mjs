import { randomBytes } from "node:crypto";
import { parse } from "dotenv";

export const CREDENTIAL_FIELDS = [
    { key: "DATABASE_URL", label: "CockroachDB DATABASE_URL", secret: true, required: true },
    { key: "GEMINI_API_KEY", label: "Google Gemini API key", secret: true, required: true },
    { key: "GROQ_API_KEY", label: "Groq API key (optional)", secret: true },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key (optional)", secret: true },
    { key: "PLAID_CLIENT_ID", label: "Plaid client ID (optional group)", secret: false },
    { key: "PLAID_SANDBOX_SECRET", label: "Plaid sandbox secret (optional group)", secret: true },
    { key: "PLAID_SANDBOX_ACCESS_TOKEN", label: "Plaid sandbox access token (optional group)", secret: true },
    { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token (Enter to configure later)", secret: true },
    { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID (Enter to configure later)", secret: false },
    { key: "COCKROACH_MCP_API_KEY", label: "CockroachDB Managed MCP API key", secret: true, required: true },
    { key: "COCKROACH_MCP_CLUSTER_ID", label: "CockroachDB Cloud cluster ID", secret: false, required: true },
];

export const CORE_KEYS = [
    "DATABASE_URL",
    "GEMINI_API_KEY",
    "TELEGRAM_WEBHOOK_SECRET",
    "COCKROACH_MCP_API_KEY",
    "COCKROACH_MCP_CLUSTER_ID",
];

export const OPTIONAL_KEYS = ["GROQ_API_KEY", "ANTHROPIC_API_KEY"];
export const PLAID_KEYS = ["PLAID_CLIENT_ID", "PLAID_SANDBOX_SECRET", "PLAID_SANDBOX_ACCESS_TOKEN"];
export const TELEGRAM_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];

export function configured(values, key) {
    return typeof values[key] === "string" && values[key].trim().length > 0;
}

export function parseEnvironment(text) {
    return parse(text);
}

export function generateWebhookSecret() {
    return randomBytes(32).toString("hex");
}

function serializeValue(value) {
    return JSON.stringify(value);
}

export function updateEnvironmentText(text, updates) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    let result = text;

    for (const [key, value] of Object.entries(updates)) {
        const linePattern = new RegExp(`^${key}=[^\\r\\n]*`, "m");
        const replacement = `${key}=${serializeValue(value)}`;
        if (linePattern.test(result)) {
            result = result.replace(linePattern, replacement);
        } else {
            if (result.length > 0 && !result.endsWith("\n")) result += newline;
            result += `${replacement}${newline}`;
        }
    }

    return result;
}

export function buildSecretValues(environment) {
    const missingCore = CORE_KEYS.filter((key) => !configured(environment, key));
    if (missingCore.length > 0) {
        throw new Error(`Missing required .env.local variables: ${missingCore.join(", ")}. Run npm run setup.`);
    }

    const missingTelegram = TELEGRAM_KEYS.filter((key) => !configured(environment, key));
    if (missingTelegram.length > 0) {
        throw new Error(
            `AWS deployment requires ${missingTelegram.join(", ")}. Configure the transferred bot with npm run setup before syncing.`,
        );
    }

    const configuredPlaidKeys = PLAID_KEYS.filter((key) => configured(environment, key));
    if (configuredPlaidKeys.length > 0 && configuredPlaidKeys.length !== PLAID_KEYS.length) {
        const missingPlaid = PLAID_KEYS.filter((key) => !configured(environment, key));
        throw new Error(`Plaid configuration is incomplete: ${missingPlaid.join(", ")}. Run npm run setup.`);
    }

    const values = {};
    for (const key of [...CORE_KEYS, ...OPTIONAL_KEYS, ...PLAID_KEYS, ...TELEGRAM_KEYS]) {
        if (configured(environment, key)) values[key] = environment[key];
    }
    return values;
}
