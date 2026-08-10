# Personal Finance Agent

Personal finance agent that connects to your bank accounts via Plaid and keeps you up-to-date on your spendings, bills, and subscriptions.

The agent has discovery tools for your finances (for looking up account info/balance, transactions, subscriptions, and liabilities) as well as an analysis tool that computes stats for your spendings (daily avg, net cash flow, top merchant, etc).

## Goals

The agent should use the OpenClaw agent style, where it runs autonomously on the background, managing the user's finances without the user's prompting. The user only needs to authorize crucial decisions. That being said, the user will get alerts if there are abnormalities in the spending patterns or transaction data. We can use Telegram as the communication line between user and agent for sake of simplicity.

- [ ] Implement background agent
- [ ] Add memory (for the hackathon) using CockroachDB MCP server
- [ ] Figure anomaly detection
- [ ] Integrate Telegram

## How to run

Before running the current code, you need the following env keys in `.env.local` (can also copy from `.env.example`):

```env
ANTHROPIC_API_KEY=
PLAID_CLIENT_ID=
PLAID_SANDBOX_SECRET=
PLAID_SANDBOX_ACCESS_TOKEN=
DATABASE_URL=
```

You need to create a Plaid sandbox and get the env keys from there. `DATABASE_URL` should point to a CockroachDB cluster (a local insecure instance works for development, e.g. `postgresql://root@localhost:26257/defaultdb?sslmode=disable`).

To run the code:

```bash
npm install
npm run db:init
npm run start
```

---

## 🤖 CockroachDB MCP & Financial Analysis Feature

This feature lets the AI search CockroachDB directly using the CockroachDB MCP Server. The AI can write SQL queries to answer questions like *"What financial mistakes did I make this year?"*.

### Step 1: Download MCP Server (Windows)
Run this script once to download the CockroachDB MCP server binary:
```powershell
.\setup-mcp.ps1
```

### Step 2: Setup Database & Add Sample Data
Make sure your local CockroachDB is running, then run these two commands:

```bash
# 1. Create financial tables and views in CockroachDB
npm run db:init:financial

# 2. Add sample transactions (food delivery, gym, tech) to the database
npm run db:seed
```

### Step 3: Run AI Financial Analysis
Ask any financial question in plain English:

```bash
npm run analysis -- "What financial mistakes did I make this year that explain why I'm broke?"
```

> **Note**: Make sure your `ANTHROPIC_API_KEY` is added in `.env.local`.

