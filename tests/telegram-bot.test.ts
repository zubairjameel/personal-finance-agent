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
        getAllowedChatId: () => "7",
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

test("bot-qualified /alerts command queries alerts instead of invoking AI", async () => {
    const sent: string[] = [];
    let agentCalls = 0;
    const dependencies: TelegramUpdateDependencies = {
        sendMessage: async (message) => { sent.push(message); return true; },
        getUser: async () => ({ id: "12345678-0000-0000-0000-000000000000" }),
        query: (async () => ({
            rows: [{ title: "Spending spike", amount: 125, severity: "HIGH", created_at: "now" }],
            command: "SELECT", rowCount: 1, oid: 0, fields: [],
        })) as TelegramUpdateDependencies["query"],
        runAgent: async () => {
            agentCalls++;
            return { answer: "unused", provider: "test", model: "test", toolCallCount: 0 };
        },
        getAllowedChatId: () => "7",
    };

    const handle = createTelegramUpdateHandler(dependencies);
    await handle({
        update_id: 4,
        message: { message_id: 4, chat: { id: 7 }, text: "/Alerts@KadmusFinanceBot", date: 0 },
    });

    assert.equal(agentCalls, 0);
    assert.match(sent[0] ?? "", /Recent Financial Anomalies/);
});

test("unauthorized Telegram chats cannot reach database, messaging, or AI", async () => {
    let dependencyCalls = 0;
    const dependencies: TelegramUpdateDependencies = {
        sendMessage: async () => { dependencyCalls++; return true; },
        getUser: async () => { dependencyCalls++; return { id: "unused" }; },
        query: (async () => { dependencyCalls++; throw new Error("must not query"); }) as TelegramUpdateDependencies["query"],
        runAgent: async () => {
            dependencyCalls++;
            return { answer: "unused", provider: "test", model: "test", toolCallCount: 0 };
        },
        getAllowedChatId: () => "7",
    };

    const handle = createTelegramUpdateHandler(dependencies);
    await handle({
        update_id: 2,
        message: { message_id: 2, chat: { id: 99 }, text: "/status", date: 0 },
    });

    assert.equal(dependencyCalls, 0);
});

test("Telegram handler fails closed when no allowed chat is configured", async () => {
    let dependencyCalls = 0;
    const dependencies: TelegramUpdateDependencies = {
        sendMessage: async () => { dependencyCalls++; return true; },
        getUser: async () => { dependencyCalls++; return { id: "unused" }; },
        query: (async () => { dependencyCalls++; throw new Error("must not query"); }) as TelegramUpdateDependencies["query"],
        runAgent: async () => {
            dependencyCalls++;
            return { answer: "unused", provider: "test", model: "test", toolCallCount: 0 };
        },
        getAllowedChatId: () => undefined,
    };

    const handle = createTelegramUpdateHandler(dependencies);
    await handle({
        update_id: 3,
        message: { message_id: 3, chat: { id: 7 }, text: "/start", date: 0 },
    });

    assert.equal(dependencyCalls, 0);
});
