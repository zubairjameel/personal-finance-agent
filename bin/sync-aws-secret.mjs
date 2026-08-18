#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { confirm } from "@inquirer/prompts";
import {
    DescribeSecretCommand,
    PutSecretValueCommand,
    SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { config } from "dotenv";
import { buildSecretValues } from "./credential-config.mjs";

function argumentValue(arguments_, name, fallback) {
    const prefix = `${name}=`;
    return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function accountFromArn(arn) {
    return arn?.split(":")[4] || "unknown";
}

export async function syncAwsSecret({
    environment,
    arguments_ = [],
    send,
    askToConfirm,
    log = console.log,
}) {
    const values = buildSecretValues(environment);
    const secretId = argumentValue(
        arguments_,
        "--secret-id",
        environment.APPLICATION_SECRET_ID?.trim() || "kadmus/application",
    );
    const region = argumentValue(
        arguments_,
        "--region",
        environment.AWS_REGION?.trim() || environment.AWS_DEFAULT_REGION?.trim() || "ap-southeast-1",
    );

    const description = await send(new DescribeSecretCommand({ SecretId: secretId }), region);
    const account = accountFromArn(description.ARN);
    const keys = Object.keys(values).sort();

    log("AWS Secrets Manager update preview:");
    log(`  Account: ${account}`);
    log(`  Region: ${region}`);
    log(`  Secret ID: ${secretId}`);
    log(`  Keys: ${keys.join(", ")}`);
    log("  Values: hidden");

    const approved = await askToConfirm({
        message: "Update this existing AWS secret?",
        default: false,
    });
    if (!approved) {
        log("Cancelled. AWS was not changed.");
        return { updated: false, account, region, secretId, keys };
    }

    const result = await send(new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify(values),
    }), region);
    log(`Updated ${secretId} successfully${result.VersionId ? ` (version ${result.VersionId})` : ""}.`);
    return { updated: true, account, region, secretId, keys };
}

async function main() {
    config({ path: ".env.local", override: true, quiet: true });
    const clients = new Map();
    const send = (command, region) => {
        if (!clients.has(region)) clients.set(region, new SecretsManagerClient({ region }));
        return clients.get(region).send(command);
    };
    await syncAwsSecret({
        environment: process.env,
        arguments_: process.argv.slice(2),
        send,
        askToConfirm: confirm,
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "AWS secret sync failed.");
        process.exitCode = 1;
    });
}
