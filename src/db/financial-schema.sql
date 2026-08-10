-- Financial history schema for open-ended SQL reasoning via MCP.
-- This is ADDITIVE to schema.sql (which manages session/message memory).
-- Run after schema.sql: npm run db:init:financial

-- Persist Plaid-linked accounts so we can JOIN against them in queries.
CREATE TABLE IF NOT EXISTS accounts (
    id             STRING PRIMARY KEY,           -- Plaid account_id
    user_id        UUID   NOT NULL REFERENCES users(id),
    name           STRING NOT NULL,              -- official_name ?? name
    type           STRING NOT NULL,              -- depository, credit, loan, etc.
    subtype        STRING,                       -- checking, savings, credit card, etc.
    currency       STRING NOT NULL DEFAULT 'USD',
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    INDEX idx_accounts_user (user_id)
);

-- Full transaction history persisted from Plaid transactionsSync.
-- Plaid sign convention preserved: positive = money out, negative = money in.
CREATE TABLE IF NOT EXISTS transactions (
    id                    STRING PRIMARY KEY,    -- Plaid transaction_id
    account_id            STRING NOT NULL REFERENCES accounts(id),
    user_id               UUID   NOT NULL REFERENCES users(id),
    date                  DATE   NOT NULL,
    authorized_date       DATE,
    merchant_name         STRING,
    name                  STRING NOT NULL,       -- raw transaction name
    amount                DECIMAL(12, 2) NOT NULL,
    currency              STRING NOT NULL DEFAULT 'USD',
    category_primary      STRING,                -- personal_finance_category.primary
    category_detailed     STRING,                -- personal_finance_category.detailed
    pending               BOOL   NOT NULL DEFAULT false,
    channel               STRING,                -- online, in store, other
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    INDEX idx_txn_user_date     (user_id, date DESC),
    INDEX idx_txn_account_date  (account_id, date DESC),
    INDEX idx_txn_category      (user_id, category_primary, date DESC),
    INDEX idx_txn_merchant      (user_id, merchant_name, date DESC)
);

-- Plaid cursor state — enables efficient incremental syncs.
CREATE TABLE IF NOT EXISTS plaid_sync_cursors (
    account_id   STRING PRIMARY KEY REFERENCES accounts(id),
    cursor       STRING NOT NULL,
    synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Convenience view: spending only (positive amounts), with year/month columns
-- for easy GROUP BY in open-ended MCP queries.
CREATE VIEW IF NOT EXISTS spending_history AS
SELECT
    t.id,
    t.account_id,
    t.user_id,
    t.date,
    EXTRACT(YEAR  FROM t.date)::INT AS year,
    EXTRACT(MONTH FROM t.date)::INT AS month,
    t.merchant_name,
    t.name          AS transaction_name,
    t.amount,
    t.currency,
    t.category_primary   AS category,
    t.category_detailed,
    t.channel,
    a.name          AS account_name,
    a.type          AS account_type
FROM transactions t
JOIN accounts a ON a.id = t.account_id
WHERE t.amount > 0   -- spending only (Plaid: positive = money out)
  AND t.pending = false;

-- Convenience view: income only (negative amounts, sign-flipped to positive)
CREATE VIEW IF NOT EXISTS income_history AS
SELECT
    t.id,
    t.account_id,
    t.user_id,
    t.date,
    EXTRACT(YEAR  FROM t.date)::INT AS year,
    EXTRACT(MONTH FROM t.date)::INT AS month,
    t.merchant_name,
    t.name          AS transaction_name,
    -t.amount       AS amount,   -- flip sign: negative plaid amount -> positive income
    t.currency,
    t.category_primary   AS category,
    a.name          AS account_name
FROM transactions t
JOIN accounts a ON a.id = t.account_id
WHERE t.amount < 0   -- income only
  AND t.pending = false;
