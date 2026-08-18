import type { TelegramUpdate } from "../telegram/bot.ts";
import { loadApplicationSecrets } from "./secrets.ts";

interface SqsRecord {
    messageId: string;
    body: string;
    attributes?: { ApproximateReceiveCount?: string };
}

export interface SqsEvent {
    Records: SqsRecord[];
}

interface BatchResponse {
    batchItemFailures: Array<{ itemIdentifier: string }>;
}

type UpdateProcessor = (update: TelegramUpdate, firstAttempt: boolean) => Promise<void>;
type SecretsLoader = (requiredKeys?: readonly string[]) => Promise<void>;

const processTelegramUpdateAfterSecrets: UpdateProcessor = async (update, firstAttempt) => {
    const { handleTelegramUpdate, parseTelegramCommand, sendTelegramMessage } = await import("../telegram/bot.ts");
    const text = update.message?.text?.trim();

    if (firstAttempt && text && !parseTelegramCommand(text)) {
        await sendTelegramMessage(
            "🔍 <i>Kadmus is querying CockroachDB and analyzing your financial memory...</i>",
            update.message!.chat.id,
        );
    }

    await handleTelegramUpdate(update);
};

export function createTelegramWorker(
    processUpdate: UpdateProcessor = processTelegramUpdateAfterSecrets,
    loadSecrets: SecretsLoader = loadApplicationSecrets,
) {
    return async (event: SqsEvent): Promise<BatchResponse> => {
        await loadSecrets(["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
        const batchItemFailures: BatchResponse["batchItemFailures"] = [];

        for (const record of event.Records) {
            try {
                const update = JSON.parse(record.body) as TelegramUpdate;
                if (!Number.isInteger(update.update_id)) throw new Error("Missing update_id");
                await processUpdate(update, record.attributes?.ApproximateReceiveCount === "1");
            } catch (error) {
                console.error(`[TelegramWorker] Failed message ${record.messageId}: ${error instanceof Error ? error.message : "Unknown error"}`);
                batchItemFailures.push({ itemIdentifier: record.messageId });
            }
        }

        return { batchItemFailures };
    };
}

export const handler = createTelegramWorker();
