#!/usr/bin/env node

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { input, password } from "@inquirer/prompts";
import {
    CREDENTIAL_FIELDS,
    configured,
    generateWebhookSecret,
    parseEnvironment,
    TELEGRAM_KEYS,
    updateEnvironmentText,
} from "./credential-config.mjs";

const localPath = ".env.local";
const examplePath = ".env.example";

async function readOrCreateLocalEnvironment() {
    try {
        return await readFile(localPath, "utf8");
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await copyFile(examplePath, localPath);
        console.log(`Created ${localPath} from ${examplePath}.`);
        return readFile(localPath, "utf8");
    }
}

const originalText = await readOrCreateLocalEnvironment();
const environment = parseEnvironment(originalText);
const updates = {};

for (const field of CREDENTIAL_FIELDS) {
    if (configured(environment, field.key)) continue;

    const promptOptions = {
        message: field.label,
        validate: field.required
            ? (answer) => answer.trim().length > 0 || `${field.key} is required.`
            : undefined,
    };
    const value = field.secret
        ? await password({ ...promptOptions, mask: "*" })
        : await input(promptOptions);
    if (value.trim().length > 0) {
        updates[field.key] = value.trim();
        environment[field.key] = value.trim();
    }
}

if (!configured(environment, "TELEGRAM_WEBHOOK_SECRET")) {
    const webhookSecret = generateWebhookSecret();
    updates.TELEGRAM_WEBHOOK_SECRET = webhookSecret;
    environment.TELEGRAM_WEBHOOK_SECRET = webhookSecret;
    console.log("Generated TELEGRAM_WEBHOOK_SECRET.");
}

if (Object.keys(updates).length > 0) {
    await writeFile(localPath, updateEnvironmentText(originalText, updates), "utf8");
    console.log(`Updated ${localPath}: ${Object.keys(updates).sort().join(", ")}`);
} else {
    console.log(`${localPath} is already configured; no values were changed.`);
}

const missingTelegram = TELEGRAM_KEYS.filter((key) => !configured(environment, key));
if (missingTelegram.length > 0) {
    console.log(`Telegram can be configured later. Still missing: ${missingTelegram.join(", ")}.`);
}

console.log("Local setup complete. Secret values were not printed.");
