import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationSecretsLoader } from "../src/lambda/secrets.ts";

test("Secrets Manager JSON is cached and required fields are validated", async () => {
    const previousArn = process.env["APPLICATION_SECRET_ARN"];
    const previousDatabase = process.env["DATABASE_URL"];
    process.env["APPLICATION_SECRET_ARN"] = "test-secret-arn";
    delete process.env["DATABASE_URL"];
    let calls = 0;
    const load = createApplicationSecretsLoader(async () => {
        calls++;
        return JSON.stringify({ DATABASE_URL: "test-database-url", UNKNOWN_KEY: "ignored" });
    });
    try {
        await load(["DATABASE_URL"]);
        await load(["DATABASE_URL"]);
        assert.equal(calls, 1);
        assert.equal(process.env["DATABASE_URL"], "test-database-url");
        assert.equal(process.env["UNKNOWN_KEY"], undefined);
    } finally {
        if (previousArn === undefined) delete process.env["APPLICATION_SECRET_ARN"];
        else process.env["APPLICATION_SECRET_ARN"] = previousArn;
        if (previousDatabase === undefined) delete process.env["DATABASE_URL"];
        else process.env["DATABASE_URL"] = previousDatabase;
    }
});

test("missing required secret fields fail without exposing values", async () => {
    const previousArn = process.env["APPLICATION_SECRET_ARN"];
    process.env["APPLICATION_SECRET_ARN"] = "test-secret-arn";
    const load = createApplicationSecretsLoader(async () => "{}");
    try {
        await assert.rejects(load(["DATABASE_URL"]), /DATABASE_URL/);
    } finally {
        if (previousArn === undefined) delete process.env["APPLICATION_SECRET_ARN"];
        else process.env["APPLICATION_SECRET_ARN"] = previousArn;
    }
});
