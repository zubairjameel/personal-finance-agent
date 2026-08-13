# 🤖 Personal Finance Agent (OpenClaw-Style Autonomous Assistant)

> Built for the **CockroachDB × AWS Hackathon 2026** (Deadline: August 18, 2026).

An autonomous, always-on AI personal finance agent inspired by the **OpenClaw agent architecture**. It connects to linked bank accounts via Plaid, uses **CockroachDB** as its long-term persistent memory, leverages **CockroachDB Managed MCP Server** for open-ended financial reasoning, runs via **Amazon Bedrock**, and alerts the user on **Telegram** only when spending anomalies occur or decisions require authorization.

---

## 🎯 What Are We Building?

Traditional finance apps require manual input, static budget rules, and constant checking. Our project builds a 24/7 autonomous financial truth-teller:

1. **Autonomous Background Agent (OpenClaw Style)**:
   Runs as an always-on background daemon. It periodically inspects new transactions in CockroachDB without waiting for the user to type a prompt.

2. **CockroachDB Persistent Memory**:
   Persists full bank accounts, transaction history, cursors, and analytical views (`spending_history`, `income_history`) in CockroachDB so the AI has long-term financial memory across sessions.

3. **CockroachDB Managed MCP Server (Open-Ended Reasoning)**:
   Connects the AI directly to CockroachDB using Model Context Protocol (MCP). The AI writes unscripted SQL queries to answer any custom question like _"Why am I broke this month?"_ or _"What spending mistakes did I make?"_.

4. **Amazon Bedrock AI Engine (AWS Requirement)**:
   Powers LLM inference using Amazon Bedrock for fast, enterprise-grade reasoning.

5. **Telegram Real-Time Alerts**:
   Sends proactive push notifications directly to the user's phone on Telegram when spending anomalies (e.g. $500 impulse purchase, duplicate subscription) or authorization requests occur.

---

## 🏗️ System Architecture

```
┌──────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│    Plaid API     │ ────> │ CockroachDB Cluster  │ ────> │  CockroachDB MCP       │
│  (Live Accounts) │ Sync  │ (Persistent Memory)  │  SQL  │  Server (15 Tools)     │
└──────────────────┘       └──────────────────────┘       └───────────┬────────────┘
                                                                      │
                                                                      ▼
┌──────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│  Telegram Phone  │ <──── │  Background Daemon   │ <──── │   Amazon Bedrock /     │
│   Push Alerts    │ Alert │  (OpenClaw Loop)     │ Infer │   Claude AI Engine     │
└──────────────────┘       └──────────────────────┘       └────────────────────────┘
```

---

## 🛠️ Tech Stack & Hackathon Requirements

| Requirement              | Technology                                                                         | Status         |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------- |
| **CockroachDB Tool 1**   | **CockroachDB Managed MCP Server** (Native 15 SQL Tools)                           | ✅ Completed   |
| **CockroachDB Tool 2**   | **CockroachDB Agent Skills** (`cockroachdb-sql`, `setting-up-local-cluster`, etc.) | ✅ Completed   |
| **AWS Service 1**        | **Amazon Bedrock** (LLM Inference Engine)                                          | 🔄 In Progress |
| **Storage & Memory**     | CockroachDB v25.4 (CCL Distributed SQL)                                            | ✅ Completed   |
| **Financial API**        | Plaid API Sandbox (`transactionsSync`, `identityGet`, `liabilitiesGet`)            | ✅ Completed   |
| **Multi-Channel Alerts** | Telegram Bot API                                                                   | 🔄 In Progress |

---

## 🚀 Quick Start Guide for Team Members

### Step 1: Clone & Install Dependencies

```bash
git clone https://github.com/zubairjameel/personal-finance-agent.git
cd personal-finance-agent
npm install
```

### Step 2: Download CockroachDB MCP Server Binary (Windows)

```powershell
.\setup-mcp.ps1
```

### Step 3: Initialize CockroachDB Database & Seed Sample Data

Make sure your local CockroachDB cluster is running (`postgresql://root@localhost:26257/defaultdb?sslmode=disable`), then run:

```bash
# 1. Create financial tables & analytical views in CockroachDB
npm run db:init:financial

# 2. Seed realistic sample transactions (food delivery, subscriptions, tech)
npm run db:seed
```

### Step 4: Test CockroachDB MCP & Financial Analysis

Run the MCP Server demo script to verify 15 native tools & SQL querying:

```bash
node bin/test-demo.mjs
```

Or ask any unscripted financial question using the dynamic AI analysis agent:

```bash
npm run analysis -- "What financial mistakes did I make this year that explain why I'm broke?"
```

_(Make sure `ANTHROPIC_API_KEY` is set in `.env.local`)_

---

## 📁 Repository Structure

```
personal-finance-agent/
├── bin/                       # Pre-built CockroachDB MCP binary & demo scripts
├── src/
│   ├── analysis/              # Open-ended financial reasoning agent (mistakes-agent.ts)
│   ├── agent/                 # Serey's CLI agent & background loop components
│   ├── db/                    # CockroachDB connection, schemas, init, & seed scripts
│   └── mcp/                   # CockroachDB MCP client connector & Plaid sync engine
├── setup-mcp.ps1              # One-shot MCP binary setup script
├── package.json
└── README.md
```
