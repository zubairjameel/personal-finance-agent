import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
let loaded = false;

/** Load the deployment's JSON secret without printing its ARN or contents. */
export async function loadApplicationSecrets(): Promise<void> {
    if (loaded) return;
    const secretId = process.env["APPLICATION_SECRET_ARN"];
    if (!secretId) {
        loaded = true;
        return;
    }
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString) throw new Error("Application secret has no SecretString");
    const values = JSON.parse(response.SecretString) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" && value.length > 0 && !process.env[key]) {
            process.env[key] = value;
        }
    }
    loaded = true;
}
