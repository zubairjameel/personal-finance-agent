import { timingSafeEqual } from "crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { TelegramUpdate } from "../telegram/bot.ts";
import { loadApplicationSecrets } from "./secrets.ts";

export interface HttpEvent {
    headers?: Record<string, string | undefined>;
    body?: string | null;
    isBase64Encoded?: boolean;
}

type UpdateEnqueuer = (update: TelegramUpdate) => Promise<void>;
type SecretsLoader = (requiredKeys?: readonly string[]) => Promise<void>;

const sqs = new SQSClient({});

const enqueueTelegramUpdate: UpdateEnqueuer = async (update) => {
    const queueUrl = process.env["TELEGRAM_QUEUE_URL"];
    if (!queueUrl) throw new Error("TELEGRAM_QUEUE_URL is not configured");

    await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(update),
        MessageGroupId: String(update.message?.chat.id ?? "telegram"),
        MessageDeduplicationId: String(update.update_id),
    }));
};

function header(event: HttpEvent, name: string): string | undefined {
    const sought = name.toLowerCase();
    return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === sought)?.[1];
}

function secretsMatch(actual: string | undefined, expected: string): boolean {
    if (!actual) return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function createTelegramHandler(
    enqueueUpdate: UpdateEnqueuer = enqueueTelegramUpdate,
    loadSecrets: SecretsLoader = loadApplicationSecrets,
) {
    return async (event: HttpEvent): Promise<{ statusCode: number; body: string }> => {
        await loadSecrets(["TELEGRAM_WEBHOOK_SECRET"]);
        const expected = process.env["TELEGRAM_WEBHOOK_SECRET"];
        if (!expected) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
        if (!secretsMatch(header(event, "x-telegram-bot-api-secret-token"), expected)) {
            return { statusCode: 401, body: "Unauthorized" };
        }
        try {
            const raw = event.isBase64Encoded
                ? Buffer.from(event.body ?? "", "base64").toString("utf8")
                : event.body ?? "";
            const update = JSON.parse(raw) as TelegramUpdate;
            if (!Number.isInteger(update.update_id)) throw new Error("Missing update_id");
            await enqueueUpdate(update);
            return { statusCode: 200, body: "OK" };
        } catch (error) {
            if (error instanceof SyntaxError || (error instanceof Error && error.message === "Missing update_id")) {
                return { statusCode: 400, body: "Invalid update" };
            }
            throw error;
        }
    };
}

export const handler = createTelegramHandler();
