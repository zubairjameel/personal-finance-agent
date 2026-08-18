import assert from "node:assert/strict";
import test from "node:test";
import {
    buildSecretValues,
    generateWebhookSecret,
    parseEnvironment,
    updateEnvironmentText,
} from "../bin/credential-config.mjs";
import { syncAwsSecret } from "../bin/sync-aws-secret.mjs";

const completeEnvironment = {
    DATABASE_URL: "database-secret-value",
    GEMINI_API_KEY: "gemini-secret-value",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
    COCKROACH_MCP_API_KEY: "mcp-secret-value",
    COCKROACH_MCP_CLUSTER_ID: "cluster-id",
    TELEGRAM_BOT_TOKEN: "telegram-secret-value",
    TELEGRAM_CHAT_ID: "123456",
};

test("environment updates preserve comments, ordering, and parseable values", () => {
    const original = "# Header\r\nDATABASE_URL=\r\nGEMINI_API_KEY=existing\r\n";
    const updated = updateEnvironmentText(original, {
        DATABASE_URL: "postgresql://user:p#ss@example/db?sslmode=require",
        TELEGRAM_WEBHOOK_SECRET: "generated-secret",
    });

    assert.match(updated, /^# Header\r\nDATABASE_URL=/);
    assert.doesNotMatch(updated, /(?<!\r)\n/);
    assert.ok(updated.indexOf("DATABASE_URL=") < updated.indexOf("GEMINI_API_KEY="));
    assert.ok(updated.indexOf("GEMINI_API_KEY=") < updated.indexOf("TELEGRAM_WEBHOOK_SECRET="));
    assert.deepEqual(parseEnvironment(updated), {
        DATABASE_URL: "postgresql://user:p#ss@example/db?sslmode=require",
        GEMINI_API_KEY: "existing",
        TELEGRAM_WEBHOOK_SECRET: "generated-secret",
    });
});

test("webhook secrets are generated securely without placeholder data", () => {
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.match(second, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
});

test("AWS sync requires Telegram while local configuration may omit it", () => {
    const localOnly = { ...completeEnvironment };
    delete localOnly.TELEGRAM_BOT_TOKEN;
    delete localOnly.TELEGRAM_CHAT_ID;

    assert.throws(
        () => buildSecretValues(localOnly),
        /TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/,
    );
});

test("cancelling AWS confirmation never sends PutSecretValue and hides values", async () => {
    const commands = [];
    const output = [];
    const result = await syncAwsSecret({
        environment: completeEnvironment,
        send: async (command) => {
            commands.push(command.constructor.name);
            return { ARN: "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:kadmus/application" };
        },
        askToConfirm: async () => false,
        log: (message) => output.push(message),
    });

    assert.equal(result.updated, false);
    assert.deepEqual(commands, ["DescribeSecretCommand"]);
    const displayed = output.join("\n");
    assert.match(displayed, /Account: 123456789012/);
    assert.match(displayed, /Values: hidden/);
    for (const secret of [
        completeEnvironment.DATABASE_URL,
        completeEnvironment.GEMINI_API_KEY,
        completeEnvironment.TELEGRAM_WEBHOOK_SECRET,
        completeEnvironment.COCKROACH_MCP_API_KEY,
        completeEnvironment.TELEGRAM_BOT_TOKEN,
    ]) {
        assert.doesNotMatch(displayed, new RegExp(secret));
    }
});

test("approved AWS sync writes the expected JSON to the existing secret", async () => {
    const commands = [];
    const result = await syncAwsSecret({
        environment: completeEnvironment,
        send: async (command) => {
            commands.push(command);
            if (command.constructor.name === "DescribeSecretCommand") {
                return { ARN: "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:kadmus/application" };
            }
            return { VersionId: "version-id" };
        },
        askToConfirm: async () => true,
        log: () => {},
    });

    assert.equal(result.updated, true);
    assert.equal(commands.length, 2);
    assert.equal(commands[1].input.SecretId, "kadmus/application");
    assert.deepEqual(JSON.parse(commands[1].input.SecretString), completeEnvironment);
});
