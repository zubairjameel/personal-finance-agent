# 🤖 Kadmus — Personal Finance Sentinel & Autonomous Agent

> Built for the **CockroachDB × AWS Hackathon 2026** (Deadline: August 18, 2026).

An autonomous, always-on AI personal finance sentinel inspired by the **OpenClaw agent architecture**. It links bank accounts via Plaid, uses **CockroachDB v25.4** as its long-term persistent memory with **Distributed Vector Indexing (768-dim)**, leverages the **CockroachDB Managed MCP Server** for open-ended financial reasoning, runs via a resilient **Multi-Provider AI Cascade (Groq / Gemini / Bedrock / Anthropic)**, and proactively alerts & interacts with the user 24/7 on **Telegram**.

---

## 🎯 What Are We Building?

Traditional finance apps require manual input, rigid categorization, and constant manual checking. Kadmus is a 24/7 autonomous financial truth-teller:

1. **Autonomous Heartbeat Daemon (OpenClaw Style)**:
   Runs as an always-on background sentinel. It periodically inspects new transactions in CockroachDB, detects spending spikes and subscription traps, and pushes proactive alerts.

2. **CockroachDB Persistent Memory & Analytical Views**:
   Persists bank accounts, transaction history, cursors, and views (`spending_history`, `income_history`, `anomalies`) in CockroachDB for long-term multi-session context.

3. **Outcome-Verified Agentic Memory (Distributed Vector Indexing)**:
   Stores past financial advice in CockroachDB `agent_memory` with 768-dimensional vector embeddings. Employs an **Outcome Verification** loop (`REUSE` vs `ABSTAIN`) so bad or stale advice is never repeated.

4. **CockroachDB Managed MCP Server (Open-Ended Reasoning)**:
   Connects the AI directly to CockroachDB using the Model Context Protocol (MCP). The AI writes dynamic SQL queries to diagnose complex questions like _"Why am I broke this month?"_ or _"What spending mistakes did I make?"_.

5. **Multi-Provider AI Engine (Groq / Gemini / Bedrock)**:
   Resilient AI cascade with zero-dependency fallback: fast free inference via Groq/Gemini, enterprise-grade reasoning via Amazon Bedrock/Claude.

6. **Telegram Real-Time Interactive Sentinel**:
   Full bi-directional Telegram bot (`KadmusFinanceBot`). Supports interactive queries, live status monitoring (`/status`), recent anomaly audits (`/alerts`), and proactive push alerts.

---

## 🏗️ System Architecture

```
┌──────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│    Plaid API     │ ────> │ CockroachDB Cluster  │ ────> │  CockroachDB MCP       │
│  (Live Accounts) │ Sync  │ (Persistent Memory)  │  SQL  │  Server (15 Tools)     │
│                  │       │ + 768-dim Vector DB  │       │                        │
└──────────────────┘       └──────────────────────┘       └───────────┬────────────┘
                                                                      │
                                                                      ▼
┌──────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│  Telegram Phone  │ <──── │  Background Daemon   │ <──── │  Multi-Provider AI     │
│   Push Alerts    │ Alert │  (OpenClaw Loop)     │ Infer │  (Groq / Bedrock /     │
│  + 2-way Chat    │       │                      │       │   Gemini / Claude)     │
└──────────────────┘       └──────────────────────┘       └────────────────────────┘
```

---

## 🛠️ Tech Stack & Hackathon Requirements

| Requirement | Technology | Status |
|---|---|---|
| **CockroachDB Tool 1** | **CockroachDB Managed MCP Server** (Native 15 SQL Tools over stdio) | ✅ Completed |
| **CockroachDB Tool 2** | **CockroachDB Agent Skills & Distributed Vector Memory** (`agent_memory` 768-dim embeddings) | ✅ Completed |
| **Storage & Memory** | CockroachDB v25.4 (CCL Distributed SQL, Views & Indexes) | ✅ Completed |
| **AI Reasoning Engine** | Multi-Provider Cascade (Groq / Google Gemini / Amazon Bedrock / Anthropic) | ✅ Completed |
| **Financial API** | Plaid API Sandbox (`transactionsSync`, `identityGet`, `liabilitiesGet`) | ✅ Completed |
| **Multi-Channel Alerts** | Telegram Bot API (`KadmusFinanceBot` with real-time push & interactive Q&A) | ✅ Completed |
| **Agent Daemon** | 24/7 OpenClaw-Style Background Heartbeat Loop (`start-daemon.mjs`) | ✅ Completed |

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

# AI Providers (At least one required)
GROQ_API_KEY=gsk_your_groq_key
GEMINI_API_KEY=your_gemini_key

# Telegram Sentinel
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_CHAT_ID=your_chat_id

# Plaid API (Optional sandbox credentials)
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SANDBOX_SECRET=your_plaid_secret
```

### Step 3: Initialize CockroachDB & Seed Sample Data

Make sure CockroachDB is running, then execute:

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

### Step 5: Test Financial Reasoning CLI

```bash
npm run analysis -- "What financial mistakes did I make that explain why I'm broke?"
```

---

## 📱 Telegram Commands

- `/start` — Welcome & overview of capabilities
- `/status` — Real-time database connection status, transaction counts, and active AI engine
- `/alerts` — Audit recent detected financial anomalies
- **Any Natural Question** — e.g. *"What did I spend the most money on this month?"* (Queries CockroachDB via MCP tools in real-time)

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
│   │   ├── mcp-agent.ts           # Multi-provider reasoning agent (Groq/Gemini/Claude)
│   │   ├── outcome-memory.ts      # CockroachDB Vector Memory (768-dim embeddings)
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
