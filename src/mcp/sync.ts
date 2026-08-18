/**
 * src/mcp/sync.ts
 *
 * Plaid → CockroachDB transaction sync.
 *
 * Persists linked accounts and their full transaction history into the
 * `accounts` / `transactions` tables so the MCP server can run open-ended
 * SQL queries over real financial data.
 *
 * Design principle: this module is WRITE-only (to the DB). The MCP client
 * is used for the analysis queries. Serey's in-memory Plaid tools remain
 * untouched and continue to work for the CLI chat loop.
 */

import { config } from "dotenv";
import { pool } from "../db/index.ts";
import {
    Configuration,
    PlaidApi,
    PlaidEnvironments,
    type Transaction,
    type TransactionsSyncRequest,
} from "plaid";

config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Plaid client (re-created here so sync can run standalone)
// ---------------------------------------------------------------------------

function buildPlaidClient(): PlaidApi {
    const configuration = new Configuration({
        basePath: PlaidEnvironments.sandbox!,
        baseOptions: {
            headers: {
                "PLAID-CLIENT-ID": process.env["PLAID_CLIENT_ID"]!,
                "PLAID-SECRET": process.env["PLAID_SANDBOX_SECRET"]!,
            },
        },
    });
    return new PlaidApi(configuration);
}

// ---------------------------------------------------------------------------
// Account sync
// ---------------------------------------------------------------------------

export interface SyncedAccount {
    id: string;
    name: string;
    type: string;
    subtype: string | null;
}

/**
 * Upsert all accounts for the given access token into the `accounts` table.
 * Returns the list of account IDs synced.
 */
export async function syncAccounts(
    plaidClient: PlaidApi,
    userId: string,
    accessToken: string,
): Promise<SyncedAccount[]> {
    const response = await plaidClient.accountsGet({
        access_token: accessToken,
    });

    const accounts = response.data.accounts;

    for (const account of accounts) {
        await pool.query(
            `INSERT INTO accounts (id, user_id, name, type, subtype, currency, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (id) DO UPDATE SET
               name      = EXCLUDED.name,
               type      = EXCLUDED.type,
               subtype   = EXCLUDED.subtype,
               synced_at = now()`,
            [
                account.account_id,
                userId,
                account.official_name ?? account.name,
                account.type,
                account.subtype ?? null,
                account.balances.iso_currency_code ?? "USD",
            ],
        );
    }

    return accounts.map((a) => ({
        id: a.account_id,
        name: a.official_name ?? a.name,
        type: String(a.type),
        subtype: a.subtype ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Transaction sync (incremental via Plaid cursor)
// ---------------------------------------------------------------------------

interface SyncStats {
    added: number;
    modified: number;
    removed: number;
}

async function getCursor(accountId: string): Promise<string | undefined> {
    const result = await pool.query<{ cursor: string }>(
        "SELECT cursor FROM plaid_sync_cursors WHERE account_id = $1",
        [accountId],
    );
    return result.rows[0]?.cursor;
}

async function saveCursor(accountId: string, cursor: string): Promise<void> {
    await pool.query(
        `INSERT INTO plaid_sync_cursors (account_id, cursor, synced_at)
         VALUES ($1, $2, now())
         ON CONFLICT (account_id) DO UPDATE SET
           cursor    = EXCLUDED.cursor,
           synced_at = now()`,
        [accountId, cursor],
    );
}

async function upsertTransaction(
    t: Transaction,
    userId: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO transactions
           (id, account_id, user_id, date, authorized_date, merchant_name, name,
            amount, currency, category_primary, category_detailed, pending,
            channel, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           merchant_name     = EXCLUDED.merchant_name,
           name              = EXCLUDED.name,
           amount            = EXCLUDED.amount,
           category_primary  = EXCLUDED.category_primary,
           category_detailed = EXCLUDED.category_detailed,
           pending           = EXCLUDED.pending,
           updated_at        = now()`,
        [
            t.transaction_id,
            t.account_id,
            userId,
            t.date,
            t.authorized_date ?? null,
            t.merchant_name ?? null,
            t.name,
            t.amount,
            t.iso_currency_code ?? "USD",
            t.personal_finance_category?.primary ?? null,
            t.personal_finance_category?.detailed ?? null,
            t.pending,
            t.payment_channel ?? null,
        ],
    );
}

/**
 * Incrementally sync all transactions for a single account into CockroachDB.
 * Uses Plaid's cursor-based pagination to only fetch new/changed data.
 */
export async function syncTransactionsForAccount(
    plaidClient: PlaidApi,
    accountId: string,
    userId: string,
    accessToken: string,
): Promise<SyncStats> {
    const stats: SyncStats = { added: 0, modified: 0, removed: 0 };
    const cursor = await getCursor(accountId);
    let nextCursor = cursor;
    let hasMore = true;

    while (hasMore) {
        const request: TransactionsSyncRequest = {
            access_token: accessToken,
            options: {
                account_id: accountId,
                include_personal_finance_category: true,
            },
            ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        };

        const response = await plaidClient.transactionsSync(request);
        const { added, modified, removed, next_cursor, has_more } =
            response.data;

        for (const t of added) {
            await upsertTransaction(t, userId);
            stats.added++;
        }
        for (const t of modified) {
            await upsertTransaction(t, userId);
            stats.modified++;
        }
        for (const t of removed) {
            await pool.query("DELETE FROM transactions WHERE id = $1", [
                t.transaction_id,
            ]);
            stats.removed++;
        }

        nextCursor = next_cursor;
        hasMore = has_more;
    }

    if (nextCursor) {
        await saveCursor(accountId, nextCursor);
    }

    return stats;
}

/**
 * Full sync: accounts + all transactions for the configured access token.
 * Call this on agent startup, or on demand via the sync_transactions tool.
 */
export async function fullSync(userId: string): Promise<{
    accounts: SyncedAccount[];
    stats: Record<string, SyncStats>;
}> {
    const plaidClient = buildPlaidClient();
    const accessToken = process.env["PLAID_SANDBOX_ACCESS_TOKEN"]!;

    const accounts = await syncAccounts(plaidClient, userId, accessToken);
    const stats: Record<string, SyncStats> = {};

    for (const account of accounts) {
        stats[account.id] = await syncTransactionsForAccount(
            plaidClient,
            account.id,
            userId,
            accessToken,
        );
    }

    return { accounts, stats };
}

// ---------------------------------------------------------------------------
// Standalone runner (npm run db:sync)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const { getOrCreateUser } = await import("../db/index.ts");
    const user = await getOrCreateUser();
    console.log(`Syncing for user ${user.id}…`);
    const result = await fullSync(user.id);
    console.log(`Synced ${result.accounts.length} account(s):`);
    for (const [accountId, s] of Object.entries(result.stats)) {
        console.log(
            `  ${accountId}: +${s.added} added, ~${s.modified} modified, -${s.removed} removed`,
        );
    }
    await pool.end();
}

const invokedFile = process.argv[1]?.replaceAll("\\", "/");
const isDirectExecution =
    invokedFile?.endsWith("/sync.ts") === true ||
    invokedFile?.endsWith("/sync.js") === true;

if (isDirectExecution) {
    main().catch((error) => {
        console.error("Plaid sync failed:", error instanceof Error ? error.message : String(error));
        pool.end().finally(() => process.exit(1));
    });
}
