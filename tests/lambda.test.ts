import assert from "node:assert/strict";
import test from "node:test";
import { createHeartbeatHandler } from "../src/lambda/heartbeat.ts";
import { createTelegramHandler } from "../src/lambda/telegram.ts";

test("heartbeat invokes exactly one cycle", async () => {
    let calls = 0;
    const handler = createHeartbeatHandler(async () => {
        calls++;
        return { cycleNumber: 1, timestamp: "now", plaidSynced: false, newAnomalies: 0, pendingAlerts: 0, errors: [] };
    }, async () => {});
    assert.equal((await handler()).statusCode, 200);
    assert.equal(calls, 1);
});

test("Telegram rejects an invalid secret", async () => {
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "expected";
    let calls = 0;
    const handler = createTelegramHandler(async () => { calls++; }, async () => {});
    const result = await handler({ headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" }, body: '{"update_id":1}' });
    assert.equal(result.statusCode, 401);
    assert.equal(calls, 0);
});

test("Telegram accepts one valid update", async () => {
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "expected";
    let updateId = 0;
    const handler = createTelegramHandler(async (update) => { updateId = update.update_id; }, async () => {});
    const result = await handler({ headers: { "x-telegram-bot-api-secret-token": "expected" }, body: '{"update_id":42}' });
    assert.equal(result.statusCode, 200);
    assert.equal(updateId, 42);
});

test("importing daemon modules does not create active timers", async () => {
    const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    await import("../src/agent/background-loop.ts");
    await import("../src/telegram/bot.ts");
    const after = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    assert.equal(after, before);
});
