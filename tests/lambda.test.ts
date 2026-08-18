import assert from "node:assert/strict";
import test from "node:test";
import { createHeartbeatHandler } from "../src/lambda/heartbeat.ts";
import { createTelegramHandler } from "../src/lambda/telegram.ts";

test("heartbeat invokes exactly one cycle", async () => {
    let calls = 0;
    const order: string[] = [];
    const handler = createHeartbeatHandler(async () => {
        order.push("cycle");
        calls++;
        return { cycleNumber: 1, timestamp: "now", plaidSynced: false, newAnomalies: 0, pendingAlerts: 0, errors: [] };
    }, async () => { order.push("secrets"); });
    assert.equal((await handler()).statusCode, 200);
    assert.equal(calls, 1);
    assert.deepEqual(order, ["secrets", "cycle"]);
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
    const previousSecret = process.env["TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TELEGRAM_WEBHOOK_SECRET"];
    let updateId = 0;
    const order: string[] = [];
    const handler = createTelegramHandler(
        async (update) => { order.push("update"); updateId = update.update_id; },
        async () => { order.push("secrets"); process.env["TELEGRAM_WEBHOOK_SECRET"] = "expected"; },
    );
    try {
        const result = await handler({ headers: { "x-telegram-bot-api-secret-token": "expected" }, body: '{"update_id":42}' });
        assert.equal(result.statusCode, 200);
        assert.equal(updateId, 42);
        assert.deepEqual(order, ["secrets", "update"]);
    } finally {
        if (previousSecret === undefined) delete process.env["TELEGRAM_WEBHOOK_SECRET"];
        else process.env["TELEGRAM_WEBHOOK_SECRET"] = previousSecret;
    }
});

test("importing daemon modules does not create active timers", async () => {
    const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    await import("../src/agent/background-loop.ts");
    await import("../src/telegram/bot.ts");
    const after = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    assert.equal(after, before);
});
