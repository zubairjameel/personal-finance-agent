import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { SYSTEM_PROMPT } from "./prompts.js";
import { createTools } from "./tools.js";

config({ path: ".env.local" });

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

const chatStream = async (userMessage: string) => {
    const controller = new AbortController();
    const runner = client.beta.messages.toolRunner(
        {
            model: "claude-haiku-4-5",
            max_tokens: 1000,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
            stream: true,
            tools: createTools(plaidClient),
            tool_choice: { type: "auto", disable_parallel_tool_use: false },
            max_iterations: 10,
        },
        { signal: controller.signal },
    );

    process.stdout.write("Assistant: ");
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
                        process.stdout.write(event.delta.text);
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
                        process.stdout.write(
                            `\n  → ${pending.name}(${summarizeToolInput(pending.json)})\n`,
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
    process.stdout.write("\n");
    return () => {
        controller.abort();
    };
};

async function main() {
    const rl = readline.createInterface({ input, output });

    let abortFn: (() => void) | null = null;
    while (true) {
        const userInput = await rl.question("You: ");

        if (
            userInput.trim() === "" ||
            userInput.trim().toLowerCase() === "exit"
        ) {
            if (abortFn) {
                abortFn();
            }
            break;
        }

        abortFn = await chatStream(userInput);
    }

    rl.close();
}

main();
