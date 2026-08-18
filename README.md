# 🤖 Kadmus — Autonomous Financial Sentinel

> Built for the **CockroachDB × AWS Hackathon 2026** (Submission Deadline: August 18, 2026).

An autonomous, always-on AI personal finance sentinel inspired by the **OpenClaw agent architecture**. It links bank accounts via Plaid, uses **CockroachDB v25.4** as its long-term persistent memory with **Distributed Vector Indexing (768-dim embeddings)**, leverages the **CockroachDB Managed MCP Server** for open-ended financial reasoning, runs serverlessly via **AWS Lambda and Amazon EventBridge Scheduler**, and proactively alerts & interacts with the user in real-time on **Telegram** (`@KadmusFinanceBot`).

---

## 🏛️ CockroachDB Tools & What the Agent Did With Them

For the hackathon submission criteria, here is the exact breakdown of how Kadmus utilizes CockroachDB tools:

### 1. CockroachDB Managed MCP Server (15 Native Tools)
- **Tool**: Pre-built native binary running over `stdio` transport (`bin/cockroachdb-mcp-server.exe`).
- **What the Agent Did**: Rather than using static REST endpoints or brittle ORM queries, Kadmus connects directly to the MCP server. When a user asks a complex financial question (e.g. *"Why am I broke this month?"*), the agent uses `list_tables`, `get_table_schema`, and `select_query` to explore schemas on the fly and construct multi-table analytical joins against `spending_history`, `income_history`, `accounts`, and `anomalies`.

### 2. CockroachDB Distributed Vector Indexing (768-dim Vector Embeddings)
- **Tool**: CockroachDB `VECTOR(768)` data type with cosine/L2 distance operators (`<->`).
- **What the Agent Did**: Powering the **Outcome-Verified Agentic Memory** system (`src/ai/outcome-memory.ts`). Every recommendation given by the agent is embedded into a 768-dimensional vector space and stored in the `agent_memory` table along with its verified outcome (`success`, `failed`, `revoked`, `stale`).
  - **REUSE**: When a semantically similar question is asked and the previous outcome was verified *successful*, the agent immediately reuses the verified precedent.
  - **ABSTAIN**: If the past recommendation led to a *failed* or *revoked* outcome, the agent explicitly abstains from repeating bad advice and performs a fresh diagnostic audit.

### 3. CockroachDB Agent Skills
- **Tool**: Embedded agent skills (`cockroachdb-sql`, `designing-application-transactions`, `setting-up-local-cluster`).
- **What the Agent Did**: Guided the creation of distributed ACID schemas, idempotent views, cursor synchronization tables (`plaid_sync_cursors`), and retry-safe transactional boundaries.

### 4. CockroachDB Cloud Serverless & CLI (`ccloud`)
- **Tool**: Distributed PostgreSQL-compatible SQL engine with multi-region resilience and zero-downtime scalability.
- **What the Agent Did**: Stores user financial identity, sessions, raw transactions, and anomaly states permanently across daemon restarts.

---

## 🏗️ End-to-End System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                     AWS CLOUD                                           │
│                                                                                         │
│   ┌────────────────────────┐         ┌──────────────────────────────────────────────┐   │
│   │ EVENTBRIDGE SCHEDULER  │ ──────► │        KADMUS HEARTBEAT LAMBDA               │   │
│   │    rate(5 minutes)     │         │  • One heartbeat cycle per invocation        │   │
│   └────────────────────────┘         │  • Plaid sync + anomaly detection            │   │
│                                      │  • Telegram alert dispatch                   │   │
│                                      └──────────────────┬───────────────────────────┘   │
│                                                         │                               │
│   ┌────────────────────────┐         ┌──────────────────▼───────────────────────────┐   │
│   │ API GATEWAY HTTP API   │ ──────► │        KADMUS TELEGRAM LAMBDA                │   │
│   │   /telegram webhook    │         │  • Webhook secret verification              │   │
│   └───────────▲────────────┘         │  • One Telegram update per invocation        │   │
│               │                      └──────────────────────────────────────────────┘   │
│               │                                                                         │
│   CloudWatch Logs • Secrets Manager • SQS Dead-Letter Queue                            │
└───────────────┼─────────────────────────────────────────────────────────────────────────┘
                │
                ├───────────────────────────────────────┐
                ▼                                       ▼
┌────────────────────────────────┐     ┌──────────────────────────────────────────────────┐
│        USER INTERFACE          │     │             COCKROACHDB CLUSTER                  │
│                                │     │           (Distributed Memory Core)              │
│  📱 Telegram Bot (@Kadmus)     │     │                                                  │
│     • Proactive Anomaly Alerts │     │  1. Managed MCP Server (15 Native Tools via STDIO│
│     • 2-Way Conversational Chat│     │  2. Distributed Vector Memory (VECTOR 768-dim)   │
│     • /status & /alerts        │     │  3. Financial Views (spending & income history)  │
│                                │     │  4. Transactional Store & Plaid Sync Cursors     │
└────────────────────────────────┘     └────────────────────────┬─────────────────────────┘
                                                                ▲
                                                                │ Sync
                                               ┌────────────────┴──────────────┐
                                               │           PLAID API           │
                                               │   (Sandbox Banking Data)      │
                                               └───────────────────────────────┘
```

---

## 🛠️ Hackathon Requirements Matrix

| Requirement | Implementation Details | Status |
|---|---|---|
| **CockroachDB Tool 1** | **CockroachDB Managed MCP Server** (15 Native SQL discovery & query tools over stdio) | ✅ Completed |
| **CockroachDB Tool 2** | **CockroachDB Distributed Vector Indexing** (`agent_memory` with 768-dim vectors & outcome verification) | ✅ Completed |
| **CockroachDB Tool 3** | **CockroachDB Agent Skills** (`cockroachdb-sql`, `designing-application-transactions`) | ✅ Completed |
| **AWS Infrastructure** | **AWS Lambda** (heartbeat + Telegram), **EventBridge Scheduler**, **API Gateway HTTP API**, **CloudWatch Logs**, and **SQS DLQ** via AWS SAM | ✅ Built & Locally Validated |
| **Core Database** | CockroachDB v25.4 (CCL Distributed SQL, Views, Indexes) | ✅ Completed |
| **Financial API** | Plaid API Sandbox (`transactionsSync`, `identityGet`, `liabilitiesGet`) | ✅ Completed |
| **User Interface** | Telegram Bot API (`@KadmusFinanceBot` with real-time push & interactive Q&A) | ✅ Completed |

---

## 🚀 Quick Start Guide

### Step 1: Clone & Install Dependencies

```bash
git clone https://github.com/zubairjameel/personal-finance-agent.git
cd personal-finance-agent
npm install
```

### Step 2: Configure Environment Variables

Create `.env.local`:

```env
# CockroachDB
DATABASE_URL=postgresql://root@localhost:26257/defaultdb?sslmode=disable

# AI Engine
GROQ_API_KEY=gsk_your_groq_key
GEMINI_API_KEY=your_gemini_key

# Telegram Sentinel
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_CHAT_ID=your_chat_id

# Plaid API
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SANDBOX_SECRET=your_plaid_secret
```
```bash
npm run setup
```

For AWS, first authenticate the AWS CLI, then sync the completed local configuration:

```bash
npm run aws:sync-secret
```

The command shows the target AWS account, region, secret ID, and key names before
asking for confirmation. It updates the existing `kadmus/application` secret only;
it does not deploy or create AWS resources. Telegram credentials are required for
this production sync because the deployed Lambda cannot read local `.env.local`.
### Step 3: Initialize CockroachDB & Seed Sample Data

```bash
# 1. Apply base + financial schema (views, vector memory tables, indexes)
npm run db:init:financial

# 2. Seed realistic sample transactions (subscriptions, food delivery, impulse buys)
npm run db:seed
```

### Step 4: Run the Telegram Sentinel & Daemon

```bash
# Start Telegram interactive bot
npm run telegram

# In a separate terminal: Run the 24/7 background heartbeat daemon
npm run daemon
```

---

## 📱 Live Demo & Telegram Commands

- **Live Telegram Bot**: [`https://t.me/KadmusFinanceBot`](https://t.me/KadmusFinanceBot)
- `/start` — Welcome & overview of capabilities
- `/status` — Live database connection status, stored transaction counts, and active AI engine
- `/alerts` — Audit recent detected financial anomalies
- **Natural Language Reasoning** — e.g. *"What spending mistakes did I make?"* or *"Why am I broke this month?"* (The AI writes and executes CockroachDB SQL queries live)

---

## 📁 Repository Structure

```
personal-finance-agent/
├── bin/
│   ├── cockroachdb-mcp-server.exe # Pre-built CockroachDB Managed MCP binary
│   ├── start-daemon.mjs           # One-command daemon & CockroachDB orchestrator
│   ├── memory-feedback.mjs        # Outcome-verified memory CLI review tool
│   └── test-demo.mjs              # MCP Server verification tool
├── src/
│   ├── agent/
│   │   ├── anomaly-detector.ts    # SQL-driven anomaly detection (spikes, high purchases)
│   │   ├── background-loop.ts     # OpenClaw-style 24/7 heartbeat loop
│   │   └── prompts.ts             # System prompts & constraints
│   ├── ai/
│   │   ├── mcp-agent.ts           # Multi-provider reasoning agent (Groq/Gemini/Bedrock/Claude)
│   │   ├── outcome-memory.ts      # CockroachDB Vector Memory (768-dim embeddings, REUSE/ABSTAIN)
│   │   └── provider.ts            # Provider fallback cascade
│   ├── analysis/
│   │   └── mistakes-agent.ts      # Standalone financial diagnosis runner
│   ├── db/
│   │   ├── financial-schema.sql   # CockroachDB schema, views & agent_memory tables
│   │   ├── index.ts               # Connection pooling & user management
│   │   ├── init-financial.ts      # Idempotent DB schema initializer
│   │   └── seed-sample-data.ts    # Realistic test transaction dataset
│   ├── mcp/
│   │   ├── client.ts              # Stdio MCP client connector
│   │   └── sync.ts                # Plaid cursor-based sync engine
│   └── telegram/
│       └── bot.ts                 # Telegram Bot polling & alert dispatcher
├── package.json
└── README.md
```
