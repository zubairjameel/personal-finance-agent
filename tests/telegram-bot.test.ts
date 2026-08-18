import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramUpdateHandler, type TelegramUpdateDependencies } from "../src/telegram/bot.ts";

test("/status uses injected database and Telegram dependencies", async () => {
    const sent: string[] = [];
    let queries = 0;
    const dependencies: TelegramUpdateDependencies = {
        sendMessage: async (message) => { sent.push(message); return true; },
        getUser: async () => ({ id: "12345678-0000-0000-0000-000000000000" }),
        query: (async () => {
            queries++;
            return { rows: [{ count: queries === 1 ? "12" : "3" }], command: "SELECT", rowCount: 1, oid: 0, fields: [] };
        }) as TelegramUpdateDependencies["query"],
        runAgent: async () => ({ answer: "unused", provider: "test", model: "test", toolCallCount: 0 }),
    };
    const handle = createTelegramUpdateHandler(dependencies);
    await handle({
        update_id: 1,
        message: { message_id: 1, chat: { id: 7 }, text: "/status", date: 0 },
    });
    assert.equal(queries, 2);
    assert.match(sent[0] ?? "", /Stored Transactions:<\/b> 12/);
    assert.match(sent[0] ?? "", /Total Detected Anomalies:<\/b> 3/);
});
