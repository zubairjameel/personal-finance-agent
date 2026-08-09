import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { buildSystemPrompt } from "./prompts.ts";
import { createTools } from "./tools.ts";
import {
    getOrCreateUser,
    createSession,
    loadSessions,
    resumeSession,
    type ChatContext,
    loadMessages,
    saveMessage,
} from "../db/index.ts";

config({ path: ".env.local" });

const ansi = {
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};
const clearLine = "\r\x1b[K";

const client = new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
});

const configuration = new Configuration({
    basePath: PlaidEnvironments.sandbox!,
    baseOptions: {
        headers: {
            "PLAID-CLIENT-ID": process.env["PLAID_CLIENT_ID"]!,
            "PLAID-SECRET": process.env["PLAID_SANDBOX_SECRET"]!,
        },
    },
});

const plaidClient = new PlaidApi(configuration);

function summarizeToolInput(json: string): string {
    if (json.trim() === "") {
        return "";
    }
    try {
        return JSON.stringify(JSON.parse(json));
    } catch {
        return json;
    }
}

function createChatClient(sessionId: string, context: ChatContext) {
    const systemPrompt = buildSystemPrompt(context);
    const chatStream = async (userMessage: string) => {
        const controller = new AbortController();
        const runner = client.beta.messages.toolRunner(
            {
                model: "claude-haiku-4-5",
                max_tokens: 1000,
                system: systemPrompt,
                messages: [
                    ...context.messages.map((m) => ({
                        role: m.role,
                        content: m.content,
                    })),
                    { role: "user", content: userMessage },
                ],
                stream: true,
                tools: createTools(plaidClient),
                tool_choice: { type: "auto", disable_parallel_tool_use: false },
                max_iterations: 10,
            },
            { signal: controller.signal },
        );

        let assistantText = "";
        let hasWrittenHeader = false;
        process.stdout.write(ansi.dim("Assistant is thinking..."));
        for await (const stream of runner) {
            // Each in-flight tool_use block's input arrives as a series of
            // input_json_delta fragments -> accumulate
            // and print once complete, so calls to the same tool (e.g. one
            // per account) show their arguments instead of looking identical.
            const pendingToolCalls = new Map<
                number,
                { name: string; json: string }
            >();

            for await (const event of stream) {
                switch (event.type) {
                    case "content_block_start": {
                        if (event.content_block.type === "tool_use") {
                            pendingToolCalls.set(event.index, {
                                name: event.content_block.name,
                                json: "",
                            });
                        }
                        break;
                    }
                    case "content_block_delta": {
                        if (event.delta.type === "text_delta") {
                            if (!hasWrittenHeader) {
                                process.stdout.write(clearLine);
                                process.stdout.write(ansi.bold("Assistant: "));
                                hasWrittenHeader = true;
                            }
                            process.stdout.write(event.delta.text);
                            assistantText += event.delta.text;
                        } else if (event.delta.type === "input_json_delta") {
                            const pending = pendingToolCalls.get(event.index);
                            if (pending) {
                                pending.json += event.delta.partial_json;
                            }
                        }
                        break;
                    }
                    case "content_block_stop": {
                        const pending = pendingToolCalls.get(event.index);
                        if (pending) {
                            pendingToolCalls.delete(event.index);
                            if (!hasWrittenHeader) {
                                process.stdout.write(clearLine);
                                process.stdout.write(ansi.bold("Assistant: "));
                                hasWrittenHeader = true;
                            }
                            process.stdout.write(
                                ansi.dim(
                                    `\n  → ${pending.name}(${summarizeToolInput(pending.json)})\n`,
                                ),
                            );
                        }
                        break;
                    }
                    default: {
                        break;
                    }
                }
            }
        }
        process.stdout.write("\n\n");

        context.messages.push(
            { role: "user", content: userMessage },
            { role: "assistant", content: assistantText },
        );
        
        if (sessionId) {
            await saveMessage(sessionId, "user", userMessage);
            await saveMessage(sessionId, "assistant", assistantText);
        }

        return () => {
            controller.abort();
        };
    };
    return {
        chatStream,
    };
}

async function main() {
    const rl = readline.createInterface({ input, output });

    const user = await getOrCreateUser();
    const sessions = await loadSessions(user.id);

    let sessionId: string | null = null;
    let previousMessages: ChatContext["messages"] = [];
    if (sessions.length) {
        console.log(`\n${ansi.bold("Available sessions:")}`);
        for (const [index, session] of sessions.entries()) {
            console.log(
                `  ${ansi.cyan(`${index + 1})`)} From ${new Date(session.created_at).toLocaleString()}`,
            );
        }

        const answer = await rl.question(
            `\nResume a session by number, or press Enter to start a new one: `,
        );

        const trimmed = answer.trim().toLowerCase();
        if (trimmed !== "" && trimmed !== "n") {
            const choiceIndex = parseInt(trimmed, 10) - 1;
            const selected = sessions[choiceIndex];
            if (selected) {
                sessionId = selected.id;
                await resumeSession(sessionId, new Date().toISOString());
                previousMessages = await loadMessages(sessionId);
                console.log(
                    ansi.dim(
                        `Resumed session with ${previousMessages.length} prior message(s).`,
                    ),
                );
            } else {
                console.log(
                    ansi.dim("Invalid selection, starting a new session."),
                );
            }
        }
    }

    if (!sessionId) {
        sessionId = await createSession(user.id);
        console.log(ansi.dim("Started a new session."));
    }

    const chatClient = createChatClient(sessionId, {
        messages: previousMessages,
    });

    console.log(
        `\n${ansi.dim('Type "exit" or press Enter on a blank line to quit.')}\n`,
    );

    let abortFn: (() => void) | null = null;
    const shutdown = () => {
        if (abortFn) {
            abortFn();
        }
        rl.close();
        console.log(ansi.dim("\nGoodbye!"));
        process.exit(0);
    };
    rl.on("SIGINT", shutdown);

    while (true) {
        const userInput = await rl.question(ansi.bold("You: "));

        if (
            userInput.trim() === "" ||
            userInput.trim().toLowerCase() === "exit"
        ) {
            break;
        }

        abortFn = await chatClient.chatStream(userInput);
    }

    shutdown();
}

main();
