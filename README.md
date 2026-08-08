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
```

You need to create a Plaid sandbox and get the env keys from there.

To run the code:

```bash
npm install
npm run start
```
