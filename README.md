# Kadmus Personal Finance Agent

Kadmus is a serverless personal-finance sentinel for the CockroachDB × AWS Hackathon. EventBridge Scheduler invokes one heartbeat cycle every five minutes; Telegram sends webhook updates through API Gateway. Both workloads run as short-lived Lambda functions and store financial state in CockroachDB Cloud.

## Architecture

```text
EventBridge Scheduler ──> kadmus-heartbeat Lambda ──┐
                                                    ├──> CockroachDB Cloud
Telegram ──> API Gateway ──> kadmus-telegram Lambda ┘
                              │
                              └──> Telegram Bot API

Secrets Manager ──> both Lambdas
CloudWatch Logs <── both Lambdas
SQS DLQ <── failed scheduled deliveries
```

- `kadmus-heartbeat` runs exactly one `runHeartbeatCycle()`, optionally syncs Plaid, detects/idempotently records anomalies, dispatches pending alerts, and exits. Reserved concurrency is `1`.
- `kadmus-telegram` verifies `X-Telegram-Bot-Api-Secret-Token` and processes one update. Long polling remains only as `npm run telegram` for local development.
- CockroachDB stores financial state and outcome-verified `VECTOR(768)` memory. Its L2 query is scoped by `user_id` and matches the distributed vector index.
- Cloud Managed MCP is accessed over Streamable HTTP at `https://cockroachlabs.cloud/mcp`. A service-account API key and optional cluster ID come from Secrets Manager. Local stdio is opt-in through `COCKROACH_MCP_STDIO_COMMAND`; no binary is packaged for Lambda.
- No EC2, ECS, or Bedrock integration is claimed or required.

## Local validation

Use Node.js 22 or newer.

```bash
npm ci
npm run build
npm run lint
npm test
sam validate --lint
sam build
```

For local development only, put credentials in ignored `.env.local`. Never commit it.

```bash
npm run db:init:financial
npm run db:seed
npm run background
npm run telegram
```

## Secrets and deployment

Create one AWS Secrets Manager JSON secret with only the keys needed by the selected demo:

```text
DATABASE_URL
GROQ_API_KEY
GEMINI_API_KEY
PLAID_CLIENT_ID
PLAID_SANDBOX_SECRET
PLAID_SANDBOX_ACCESS_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
COCKROACH_MCP_API_KEY
COCKROACH_MCP_CLUSTER_ID
```

`DATABASE_URL`, Telegram credentials, and at least one AI provider key are required for the full demo. Plaid keys are optional; without them heartbeat uses existing CockroachDB data. MCP credentials are required only for MCP-backed open-ended analysis; direct SQL anomaly detection and vector memory do not depend on MCP.

Obtain the bot token from BotFather. Generate the webhook secret locally and store both through the Secrets Manager console or another secure input mechanism. Create the CockroachDB MCP service account/API key in CockroachDB Cloud Console → Access Management. Obtain SQL credentials from the cluster's Connect dialog.

Deploy only after selecting an AWS account/region and reviewing expected Lambda, API Gateway, Scheduler, SQS, CloudWatch, Secrets Manager, and X-Ray charges:

```bash
sam deploy --guided --parameter-overrides ApplicationSecretArn=<existing-secret-arn>
```

The stack output `TelegramWebhookUrl` is non-secret. Register it without placing the bot token or webhook secret in command history:

```bash
npm run telegram:webhook -- <TelegramWebhookUrl>
```

The helper reads credentials from ignored `.env.local`, sends them directly to Telegram over HTTPS, and prints only success/failure.

## Vector index verification

CockroachDB v25.4+ enables vector indexing by default. Apply the schema, then run these with `cockroach sql --url "$DATABASE_URL"` in a shell where the URL is already configured securely:

```sql
SHOW INDEXES FROM agent_memory;

EXPLAIN
SELECT id, outcome, embedding <-> '[...768 values...]'::VECTOR(768) AS distance
FROM agent_memory
WHERE user_id = '00000000-0000-0000-0000-000000000000'::UUID
  AND embedding IS NOT NULL
ORDER BY embedding <-> '[...same 768 values...]'::VECTOR(768)
LIMIT 1;
```

Confirm `idx_memory_user_embedding` appears and the plan selects the vector index. The schema uses:

```sql
CREATE VECTOR INDEX IF NOT EXISTS idx_memory_user_embedding
ON agent_memory (user_id, embedding vector_l2_ops);
```

Embedding generation uses `gemini-embedding-001` with `outputDimensionality: 768`. It fails clearly if the provider is missing, fails, or returns a different dimension; there is no fake semantic fallback.

## Demo flow

1. Show the deployed stack outputs and EventBridge schedule at `rate(5 minutes)`.
2. Invoke `kadmus-heartbeat`; show its structured result and sanitized CloudWatch logs.
3. Show new/reused anomaly rows in CockroachDB and the Telegram alert.
4. Send `/status` to the bot through the webhook and show the HTTP API/Lambda path.
5. Save a recommendation, mark its outcome `success`, repeat a similar question, and show `REUSE`.
6. Mark a similar precedent `failed`, repeat the question, and show `ABSTAIN`.
7. Run `SHOW INDEXES` and `EXPLAIN` to demonstrate the user-prefixed L2 vector index.

## Honest status

| Capability | Repository status | Live proof required |
|---|---|---|
| Lambda handlers and import safety | Implemented and locally tested | Invoke deployed functions |
| EventBridge/SQS/API Gateway/CloudWatch IaC | Defined in SAM | Deploy in selected account/region |
| Telegram webhook | Implemented | Register with real bot and test `/status` |
| CockroachDB vector index/query | Implemented in schema/code | Apply to v25.4+ cluster and inspect `EXPLAIN` |
| Cloud Managed MCP HTTP client | Implemented | Configure service-account credentials and call tools |
| Plaid sync | Existing optional sandbox path | Configure sandbox credentials |
| Bedrock | Not used | None |

Official references: [CockroachDB Cloud Managed MCP](https://www.cockroachlabs.com/docs/cockroachcloud/connect-to-the-cockroachdb-cloud-mcp-server), [CockroachDB vectors](https://www.cockroachlabs.com/docs/stable/vector), [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html), and [Telegram webhooks](https://core.telegram.org/bots/api#setwebhook).
