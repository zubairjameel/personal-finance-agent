import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Telegram webhook hands off to a FIFO SQS worker with a safe visibility timeout", async () => {
    const template = await readFile("template.yaml", "utf8");
    assert.match(template, /TelegramJobsQueue:[\s\S]*?FifoQueue: true/);
    assert.match(template, /TelegramJobsQueue:[\s\S]*?VisibilityTimeout: 1080/);
    assert.match(template, /maxReceiveCount: 5/);
    assert.match(template, /TelegramWorkerFunction:[\s\S]*?Timeout: 180/);
    assert.match(template, /TelegramFunction:[\s\S]*?TELEGRAM_QUEUE_URL: !Ref TelegramJobsQueue/);
    assert.match(template, /FunctionResponseTypes: \[ReportBatchItemFailures\]/);
});
