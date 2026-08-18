import assert from "node:assert/strict";
import test from "node:test";
import { createHeartbeatHandler } from "../src/lambda/heartbeat.ts";
import { createTelegramHandler } from "../src/lambda/telegram.ts";
import { createTelegramWorker } from "../src/lambda/telegram-worker.ts";

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

test("Telegram accepts and enqueues one valid update", async () => {
    const previousSecret = process.env["TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TELEGRAM_WEBHOOK_SECRET"];
    let enqueuedUpdateId = 0;
    const order: string[] = [];
    const handler = createTelegramHandler(
        async (update) => { order.push("enqueue"); enqueuedUpdateId = update.update_id; },
        async () => { order.push("secrets"); process.env["TELEGRAM_WEBHOOK_SECRET"] = "expected"; },
    );
    try {
        const result = await handler({ headers: { "x-telegram-bot-api-secret-token": "expected" }, body: '{"update_id":42}' });
        assert.equal(result.statusCode, 200);
        assert.equal(enqueuedUpdateId, 42);
        assert.deepEqual(order, ["secrets", "enqueue"]);
    } finally {
        if (previousSecret === undefined) delete process.env["TELEGRAM_WEBHOOK_SECRET"];
        else process.env["TELEGRAM_WEBHOOK_SECRET"] = previousSecret;
    }
});

test("Telegram worker loads secrets and marks only the first delivery attempt", async () => {
    const calls: Array<string | number | boolean> = [];
    const worker = createTelegramWorker(
        async (update, firstAttempt) => {
            calls.push(update.update_id, firstAttempt);
        },
        async () => { calls.push("secrets"); },
    );

    const first = await worker({
        Records: [{ messageId: "message-1", body: '{"update_id":42}', attributes: { ApproximateReceiveCount: "1" } }],
    });
    const retry = await worker({
        Records: [{ messageId: "message-1", body: '{"update_id":42}', attributes: { ApproximateReceiveCount: "2" } }],
    });

    assert.deepEqual(first, { batchItemFailures: [] });
    assert.deepEqual(retry, { batchItemFailures: [] });
    assert.deepEqual(calls, ["secrets", 42, true, "secrets", 42, false]);
});

test("Telegram worker returns malformed jobs for SQS retry", async () => {
    let processCalls = 0;
    const worker = createTelegramWorker(
        async () => { processCalls++; },
        async () => {},
    );

    const result = await worker({
        Records: [{ messageId: "bad-message", body: "not-json", attributes: { ApproximateReceiveCount: "1" } }],
    });

    assert.equal(processCalls, 0);
    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "bad-message" }] });
});

test("importing daemon modules does not create active timers", async () => {
    const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    await import("../src/agent/background-loop.ts");
    await import("../src/telegram/bot.ts");
    const after = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    assert.equal(after, before);
});
