import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod.mjs";
import {
    AccountType,
    PlaidApi,
    type AccountsBalanceGetRequest,
    type IdentityGetRequest,
    type LiabilitiesGetRequest,
    type Owner,
    type Transaction,
    type TransactionsRecurringGetRequest,
    type TransactionsSyncRequest,
} from "plaid";
import { z } from "zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError.mjs";

interface AccountIdentity {
    type: AccountType;
    accountId: string;
    accountName: string;
}

interface AccountTransactions {
    transactions: Transaction[];
    cursor?: string;
}

const accountTransactions: Map<string, AccountTransactions> = new Map();

interface TransactionSummary {
    date: string;
    merchant: string | null;
    amount: number;
}

function toTransactionSummary(transaction: Transaction): TransactionSummary {
    return {
        date: transaction.date,
        merchant: transaction.merchant_name ?? null,
        amount: transaction.amount,
    };
}

function findLargest(transactions: Transaction[]): Transaction | null {
    return transactions.reduce<Transaction | null>(
        (largest, t) =>
            largest === null || t.amount > largest.amount ? t : largest,
        null,
    );
}

interface SpendingStats {
    total: number;
    count: number;
    avg: number;
    largest: TransactionSummary | null;
}

function summarizeSpending(transactions: Transaction[]): SpendingStats {
    const total = transactions.reduce((sum, t) => sum + t.amount, 0);
    const largest = findLargest(transactions);
    return {
        total,
        count: transactions.length,
        avg: transactions.length > 0 ? total / transactions.length : 0,
        largest: largest ? toTransactionSummary(largest) : null,
    };
}

function findMostFrequentMerchant(
    transactions: Transaction[],
): { name: string; count: number } | null {
    const counts = new Map<string, number>();
    for (const transaction of transactions) {
        if (!transaction.merchant_name) {
            continue;
        }
        counts.set(
            transaction.merchant_name,
            (counts.get(transaction.merchant_name) ?? 0) + 1,
        );
    }
    let top: { name: string; count: number } | null = null;
    for (const [name, count] of counts) {
        if (top === null || count > top.count) {
            top = { name, count };
        }
    }
    return top;
}

interface CategoryBreakdown extends SpendingStats {
    mostFrequentMerchant: { name: string; count: number } | null;
}

interface MerchantBreakdown extends SpendingStats {
    merchant: string;
}

interface PeriodStats {
    totalIncome: number;
    totalSpent: number;
    netCashFlow: number;
    dailyAverageSpend: number;
    largestTransaction: TransactionSummary | null;
    spendingByCategory: Record<string, CategoryBreakdown>;
    topMerchantsBySpend: MerchantBreakdown[];
}

const periodTotalsSchema = z.object({
    totalIncome: z.number(),
    totalSpent: z.number(),
    netCashFlow: z.number(),
});

function computePeriodStats(
    transactions: Transaction[],
    days: number,
): PeriodStats {
    // Plaid's amount sign convention: positive = money out, negative = money in.
    const income = transactions.filter((t) => t.amount < 0);
    const spending = transactions.filter((t) => t.amount > 0);

    const totalIncome = -income.reduce((sum, t) => sum + t.amount, 0);
    const totalSpent = spending.reduce((sum, t) => sum + t.amount, 0);

    const byCategory = new Map<string, Transaction[]>();
    const byMerchant = new Map<string, Transaction[]>();
    for (const transaction of spending) {
        // Fall back to an explicit bucket rather than dropping the
        // transaction — otherwise spendingByCategory silently sums to
        // less than totalSpent whenever a transaction has no category.
        const category =
            transaction.personal_finance_category?.primary ?? "UNCATEGORIZED";
        const categoryBucket = byCategory.get(category) ?? [];
        categoryBucket.push(transaction);
        byCategory.set(category, categoryBucket);

        if (!!transaction.merchant_name) {
            const bucket = byMerchant.get(transaction.merchant_name) ?? [];
            bucket.push(transaction);
            byMerchant.set(transaction.merchant_name, bucket);
        }
    }

    const spendingByCategory: Record<string, CategoryBreakdown> = {};
    for (const [category, items] of byCategory) {
        spendingByCategory[category] = {
            ...summarizeSpending(items),
            mostFrequentMerchant: findMostFrequentMerchant(items),
        };
    }

    const topMerchantsBySpend: MerchantBreakdown[] = Array.from(
        byMerchant.entries(),
    )
        .map(([merchant, items]) => ({
            merchant,
            ...summarizeSpending(items),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    const largest = findLargest(spending);

    return {
        totalIncome,
        totalSpent,
        netCashFlow: totalIncome - totalSpent,
        dailyAverageSpend: totalSpent / days,
        largestTransaction: largest ? toTransactionSummary(largest) : null,
        spendingByCategory,
        topMerchantsBySpend,
    };
}

export const createTools = (plaidClient: PlaidApi) => {
    const getAllAccountIdentities = async (): Promise<AccountIdentity[]> => {
        const request: IdentityGetRequest = {
            access_token: process.env["PLAID_SANDBOX_ACCESS_TOKEN"]!,
        };
        const response = await plaidClient.identityGet(request);
        return response.data.accounts.map((account) => ({
            type: account.type,
            accountId: account.account_id,
            accountName: account.official_name ?? account.name,
        }));
    };

    const getAllTransactions = async (accountId: string) => {
        const cache = accountTransactions.get(accountId);
        const transactionsById = new Map<string, Transaction>(
            (cache?.transactions ?? []).map((t) => [t.transaction_id, t]),
        );
        let cursor = cache?.cursor;
        let hasMore = true;
        while (hasMore) {
            const request: TransactionsSyncRequest = {
                access_token: process.env["PLAID_SANDBOX_ACCESS_TOKEN"]!,
                options: {
                    account_id: accountId,
                    include_personal_finance_category: true,
                },
                ...(cursor !== undefined ? { cursor } : {}),
            };
            const response = await plaidClient.transactionsSync(request);
            const { added, modified, removed, next_cursor, has_more } =
                response.data;

            for (const item of added) {
                transactionsById.set(item.transaction_id, item);
            }
            for (const item of modified) {
                transactionsById.set(item.transaction_id, item);
            }
            for (const item of removed) {
                transactionsById.delete(item.transaction_id);
            }

            cursor = next_cursor;
            hasMore = has_more;
        }
        accountTransactions.set(accountId, {
            ...(cursor !== undefined ? { cursor } : {}),
            transactions: Object.values(transactionsById),
        } satisfies AccountTransactions);
        return Array.from(transactionsById.values());
    };

    const getBankAccountIdentityTool = betaZodTool({
        name: "get_bank_account_identity",
        description:
            "Get identity info (account name, type) for all of the current user's bank accounts. Use when you need an account's ID or owner details, e.g. before calling other tools that require an accountId.",
        inputSchema: z.object({}),
        run: async () => {
            const identities = await getAllAccountIdentities();
            if (identities.length === 0) {
                throw new ToolError([
                    { type: "text", text: "Failed to find any accounts" },
                ]);
            }
            return JSON.stringify(identities);
        },
    });

    const getBankAccountBalancesTool = betaZodTool({
        name: "get_bank_account_balances",
        description:
            "Get current balances for all of the current user's bank accounts. Use when the user asks about their balance, available funds, or credit limit.",
        inputSchema: z.object({}),
        run: async () => {
            const request: AccountsBalanceGetRequest = {
                access_token: process.env["PLAID_SANDBOX_ACCESS_TOKEN"]!,
            };
            const response = await plaidClient.accountsBalanceGet(request);
            if (response.data.accounts.length === 0) {
                throw new ToolError([
                    { type: "text", text: "Failed to find any accounts" },
                ]);
            }
            return JSON.stringify(
                response.data.accounts.map((account) => ({
                    accountId: account.account_id,
                    available: account.balances.available,
                    current: account.balances.current,
                    limit: account.balances.limit,
                    currency: account.balances.iso_currency_code,
                })),
            );
        },
    });

    const getRecentTransactionsTool = betaZodTool({
        name: "get_recent_transactions",
        description:
            "Get the current user's recent transactions for a given account, optionally filtered by category. Use when the user wants to see, list, or search individual transactions.",
        inputSchema: z.object({
            accountId: z
                .string()
                .describe("Return transactions for this account ID"),
            category: z
                .string()
                .optional()
                .describe(
                    "Filter by personal finance category primary, e.g. FOOD_AND_DRINK",
                ),
            days: z
                .number()
                .optional()
                .describe("Only return transactions from the last N days")
                .default(90),
        }),
        run: async ({ accountId, category, days }) => {
            const allTransactions = await getAllTransactions(accountId);

            const since = new Date();
            since.setDate(since.getDate() - days);
            const sinceDateString = since.toISOString().slice(0, 10);

            let transactions = allTransactions.filter(
                (transaction) => transaction.date >= sinceDateString,
            );
            if (category !== undefined) {
                transactions = transactions.filter(
                    (transaction) =>
                        transaction.personal_finance_category?.primary ===
                        category,
                );
            }
            transactions.sort((a, b) => b.date.localeCompare(a.date));

            if (transactions.length === 0) {
                return "No matching transactions found.";
            }

            const summarized = transactions.map((transaction) => ({
                date: transaction.date,
                merchant: transaction.merchant_name,
                amount: transaction.amount,
                currency: transaction.iso_currency_code,
                category:
                    transaction.personal_finance_category?.primary ?? null,
                pending: transaction.pending,
            }));

            return JSON.stringify(summarized);
        },
    });

    const getSubscriptionsTool = betaZodTool({
        name: "get_subscriptions",
        description:
            "Get the current user's recurring subscriptions and bills for a given account (detected recurring outgoing payments). Use when the user asks about subscriptions, recurring charges, or upcoming bills.",
        inputSchema: z.object({
            accountId: z
                .string()
                .describe("Only return subscriptions for this account ID"),
        }),
        run: async ({ accountId }) => {
            const request: TransactionsRecurringGetRequest = {
                access_token: process.env["PLAID_SANDBOX_ACCESS_TOKEN"]!,
                account_ids: [accountId],
            };
            try {
                const response =
                    await plaidClient.transactionsRecurringGet(request);
                const subscriptions = response.data.outflow_streams
                    .filter((stream) => stream.is_active)
                    .map((stream) => ({
                        merchant: stream.merchant_name ?? stream.description,
                        frequency: stream.frequency,
                        averageAmount: stream.average_amount.amount,
                        currency: stream.average_amount.iso_currency_code,
                        lastDate: stream.last_date,
                        nextDate: stream.predicted_next_date ?? null,
                        category:
                            stream.personal_finance_category?.primary ?? null,
                    }));

                return subscriptions.length > 0
                    ? JSON.stringify(subscriptions)
                    : "No active subscriptions found.";
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                throw new ToolError([
                    {
                        type: "text",
                        text: `Failed to fetch subscriptions: ${message}`,
                    },
                ]);
            }
        },
    });

    const getLiabilitiesTool = betaZodTool({
        name: "get_liabilities",
        description:
            "Get the current user's credit card, mortgage, and student loan liabilities for a given account — balances, minimum payments, due dates, and interest rates. Use when the user asks how much they owe, when a loan or credit card payment is due, or about an interest rate.",
        inputSchema: z.object({
            accountId: z
                .string()
                .describe("Only return liabilities for this account ID"),
        }),
        run: async ({ accountId }) => {
            const request: LiabilitiesGetRequest = {
                access_token: process.env["PLAID_SANDBOX_ACCESS_TOKEN"]!,
                options: { account_ids: [accountId] },
            };
            try {
                const response = await plaidClient.liabilitiesGet(request);
                const { credit, mortgage, student } = response.data.liabilities;

                const summary = {
                    credit: (credit ?? []).map((liability) => ({
                        accountId: liability.account_id,
                        nextPaymentDueDate: liability.next_payment_due_date,
                        minimumPaymentAmount: liability.minimum_payment_amount,
                        lastStatementBalance: liability.last_statement_balance,
                        isOverdue: liability.is_overdue,
                    })),
                    mortgage: (mortgage ?? []).map((liability) => ({
                        accountId: liability.account_id,
                        nextPaymentDueDate: liability.next_payment_due_date,
                        nextMonthlyPayment: liability.next_monthly_payment,
                        pastDueAmount: liability.past_due_amount,
                        interestRatePercentage:
                            liability.interest_rate.percentage,
                        maturityDate: liability.maturity_date,
                    })),
                    student: (student ?? []).map((liability) => ({
                        accountId: liability.account_id,
                        nextPaymentDueDate: liability.next_payment_due_date,
                        minimumPaymentAmount: liability.minimum_payment_amount,
                        lastStatementBalance:
                            liability.last_statement_balance ?? null,
                        interestRatePercentage:
                            liability.interest_rate_percentage,
                        isOverdue: liability.is_overdue,
                        loanStatus: liability.loan_status.type,
                    })),
                };

                const hasAny =
                    summary.credit.length > 0 ||
                    summary.mortgage.length > 0 ||
                    summary.student.length > 0;

                return hasAny
                    ? JSON.stringify(summary)
                    : "No liabilities found for this account.";
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                throw new ToolError([
                    {
                        type: "text",
                        text: `Failed to fetch liabilities: ${message}`,
                    },
                ]);
            }
        },
    });

    const analyzeTransactionsTool = betaZodTool({
        name: "analyze_transactions",
        description:
            "Analyze the current user's transactions over a given date range for a given account, returning totals, income vs. spend, and category/merchant breakdowns. Use when the user asks about spending, income, or cash flow for a period.",
        inputSchema: z.object({
            accountId: z
                .string()
                .describe("Only analyze transactions for this account ID"),
            startDate: z
                .string()
                .describe(
                    "Start of the date range to analyze, as YYYY-MM-DD (inclusive)",
                ),
            endDate: z
                .string()
                .optional()
                .describe(
                    "End of the date range to analyze, as YYYY-MM-DD (inclusive). Defaults to today.",
                ),
        }),
        run: async ({ accountId, startDate, endDate }) => {
            const allTransactions = await getAllTransactions(accountId);

            const endDateString =
                endDate ?? new Date().toISOString().slice(0, 10);
            const period = allTransactions.filter(
                (transaction) =>
                    transaction.date >= startDate &&
                    transaction.date <= endDateString,
            );

            const days =
                Math.round(
                    (new Date(endDateString).getTime() -
                        new Date(startDate).getTime()) /
                        (24 * 60 * 60 * 1000),
                ) + 1;

            return JSON.stringify(computePeriodStats(period, days));
        },
    });

    const comparePeriodsTool = betaZodTool({
        name: "compare_periods",
        description:
            "Compute the change in income, spend, and net cash flow between two periods previously returned by analyze_transactions. Use when the user asks to compare two periods (e.g. this week vs. last week) — always use this instead of computing the differences yourself.",
        inputSchema: z.object({
            current: periodTotalsSchema.describe(
                "totalIncome/totalSpent/netCashFlow from the more recent analyze_transactions result",
            ),
            previous: periodTotalsSchema.describe(
                "totalIncome/totalSpent/netCashFlow from the prior analyze_transactions result being compared against",
            ),
        }),
        run: async ({ current, previous }) => {
            const spentChange = current.totalSpent - previous.totalSpent;
            const spentChangePercent =
                previous.totalSpent > 0
                    ? (spentChange / previous.totalSpent) * 100
                    : null;

            const incomeChange = current.totalIncome - previous.totalIncome;
            const incomeChangePercent =
                previous.totalIncome > 0
                    ? (incomeChange / previous.totalIncome) * 100
                    : null;

            const netCashFlowChange =
                current.netCashFlow - previous.netCashFlow;

            return JSON.stringify({
                incomeChange,
                incomeChangePercent,
                spentChange,
                spentChangePercent,
                netCashFlowChange,
            });
        },
    });

    return [
        getBankAccountBalancesTool,
        getBankAccountIdentityTool,
        getRecentTransactionsTool,
        getSubscriptionsTool,
        getLiabilitiesTool,
        analyzeTransactionsTool,
        comparePeriodsTool,
    ];
};
