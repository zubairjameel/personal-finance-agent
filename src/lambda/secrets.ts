import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const ALLOWED_SECRET_KEYS = new Set([
    "DATABASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY",
    "PLAID_CLIENT_ID", "PLAID_SANDBOX_SECRET", "PLAID_SANDBOX_ACCESS_TOKEN",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET",
    "COCKROACH_MCP_API_KEY", "COCKROACH_MCP_CLUSTER_ID",
]);

type SecretFetcher = (secretId: string) => Promise<string>;

const client = new SecretsManagerClient({});
const fetchSecret: SecretFetcher = async (secretId) => {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString) throw new Error("Application secret has no SecretString");
    return response.SecretString;
};

export function createApplicationSecretsLoader(fetchValue: SecretFetcher = fetchSecret) {
    let loadPromise: Promise<void> | null = null;

    return async (requiredKeys: readonly string[] = []): Promise<void> => {
        const secretId = process.env["APPLICATION_SECRET_ARN"];
        if (secretId && !loadPromise) {
            loadPromise = fetchValue(secretId).then((secretString) => {
                let values: Record<string, unknown>;
                try {
                    values = JSON.parse(secretString) as Record<string, unknown>;
                } catch {
                    throw new Error("Application secret must contain a JSON object");
                }
                for (const [key, value] of Object.entries(values)) {
                    if (ALLOWED_SECRET_KEYS.has(key) && typeof value === "string" && value.length > 0) {
                        process.env[key] = value;
                    }
                }
            });
        }

        if (loadPromise) {
            try {
                await loadPromise;
            } catch (error) {
                loadPromise = null;
                throw error;
            }
        }

        const missing = requiredKeys.filter((key) => !process.env[key]);
        if (missing.length > 0) {
            throw new Error(`Application configuration is missing required fields: ${missing.join(", ")}`);
        }
    };
}

export const loadApplicationSecrets = createApplicationSecretsLoader();
