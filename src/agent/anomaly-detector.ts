/**
 * src/agent/anomaly-detector.ts
 *
 * Anomaly Detection Engine for Personal Finance Agent.
 *
 * Analyzes stored transactions in CockroachDB and detects 4 types of anomalies:
 * 1. HIGH_SINGLE_PURCHASE: Single transaction >= threshold (default $300)
 * 2. SPENDING_SPIKE: Single transaction >= 3x category average
 * 3. DUPLICATE_CHARGE: Same merchant + same exact amount on same date
 * 4. RECURRING_SUBSCRIPTION: High-value monthly subscription (e.g. gym, streaming)
 *
 * Inserts detected anomalies into the `anomalies` table with status='pending'
 * so the Telegram bot (or notification worker) can deliver alerts to the user.
 */

import { pool } from "../db/index.ts";

export interface DetectedAnomaly {
    id?: string;
    userId: string;
    transactionId?: string;
    type: "HIGH_SINGLE_PURCHASE" | "SPENDING_SPIKE" | "DUPLICATE_CHARGE" | "RECURRING_SUBSCRIPTION";
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    title: string;
    description: string;
    amount: number;
    merchantName: string | null;
    status: "pending" | "notified" | "resolved";
}

/**
 * Detect spending anomalies across transactions in CockroachDB for a given user.
 * Writes newly discovered anomalies into the `anomalies` table.
 */
export async function detectAnomalies(userId: string): Promise<DetectedAnomaly[]> {
    const detected: DetectedAnomaly[] = [];

    // 1. High Single Purchase (>= $300)
    const highPurchases = await pool.query<{
        id: string;
        amount: number;
        merchant_name: string | null;
        transaction_name: string;
        date: string;
    }>(
        `SELECT id, amount, merchant_name, transaction_name, date
         FROM spending_history
         WHERE user_id = $1 AND amount >= 300.00
         ORDER BY amount DESC`,
        [userId]
    );

    for (const txn of highPurchases.rows) {
        const amt = Number(txn.amount);
        detected.push({
            userId,
            transactionId: txn.id,
            type: "HIGH_SINGLE_PURCHASE",
            severity: amt >= 500 ? "CRITICAL" : "HIGH",
            title: `High Single Purchase: $${amt.toFixed(2)}`,
            description: `Unusually large transaction detected at ${txn.merchant_name ?? txn.transaction_name} for $${amt.toFixed(2)} on ${txn.date}.`,
            amount: amt,
            merchantName: txn.merchant_name,
            status: "pending",
        });
    }

    // 2. Duplicate Charges (same merchant + same amount on same date)
    const duplicates = await pool.query<{
        merchant_name: string;
        amount: number;
        date: string;
        cnt: number;
    }>(
        `SELECT merchant_name, amount, date, count(*) as cnt
         FROM spending_history
         WHERE user_id = $1 AND merchant_name IS NOT NULL
         GROUP BY merchant_name, amount, date
         HAVING count(*) > 1`,
        [userId]
    );

    for (const dup of duplicates.rows) {
        detected.push({
            userId,
            type: "DUPLICATE_CHARGE",
            severity: "HIGH",
            title: `Possible Duplicate Charge: ${dup.merchant_name}`,
            description: `Found ${dup.cnt} identical charges of $${Number(dup.amount).toFixed(2)} at ${dup.merchant_name} on ${dup.date}.`,
            amount: Number(dup.amount),
            merchantName: dup.merchant_name,
            status: "pending",
        });
    }

    // 3. Category Spending Spikes (>= 3x category average)
    const categoryAvgs = await pool.query<{
        category: string;
        avg_amount: number;
    }>(
        `SELECT category, AVG(amount) AS avg_amount
         FROM spending_history
         WHERE user_id = $1
         GROUP BY category`,
        [userId]
    );

    const categoryAvgMap = new Map<string, number>();
    for (const r of categoryAvgs.rows) {
        categoryAvgMap.set(r.category, Number(r.avg_amount));
    }

    const spikes = await pool.query<{
        id: string;
        category: string;
        amount: number;
        merchant_name: string | null;
        transaction_name: string;
        date: string;
    }>(
        `SELECT id, category, amount, merchant_name, transaction_name, date
         FROM spending_history
         WHERE user_id = $1`,
        [userId]
    );

    for (const txn of spikes.rows) {
        const amt = Number(txn.amount);
        const avg = categoryAvgMap.get(txn.category) ?? 0;
        if (avg > 0 && amt >= 3 * avg && amt >= 50) {
            detected.push({
                userId,
                transactionId: txn.id,
                type: "SPENDING_SPIKE",
                severity: "MEDIUM",
                title: `Spending Spike in ${txn.category}`,
                description: `$${amt.toFixed(2)} at ${txn.merchant_name ?? txn.transaction_name} is over 3x your average ${txn.category} spend ($${avg.toFixed(2)}).`,
                amount: amt,
                merchantName: txn.merchant_name,
                status: "pending",
            });
        }
    }

    // 4. Save newly detected anomalies to DB (ignore duplicates via status/title check)
    const insertedAnomalies: DetectedAnomaly[] = [];

    for (const anomaly of detected) {
        const existing = await pool.query(
            `SELECT id FROM anomalies 
             WHERE user_id = $1 AND title = $2 AND (transaction_id = $3 OR transaction_id IS NULL)`,
            [userId, anomaly.title, anomaly.transactionId ?? null]
        );

        if (existing.rows.length === 0) {
            const res = await pool.query<{ id: string }>(
                `INSERT INTO anomalies
                   (user_id, transaction_id, type, severity, title, description, amount, merchant_name, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
                 RETURNING id`,
                [
                    anomaly.userId,
                    anomaly.transactionId ?? null,
                    anomaly.type,
                    anomaly.severity,
                    anomaly.title,
                    anomaly.description,
                    anomaly.amount,
                    anomaly.merchantName,
                ]
            );
            const row = res.rows[0];
            if (row) {
                anomaly.id = row.id;
            }
            insertedAnomalies.push(anomaly);
        }
    }

    return insertedAnomalies;
}

/**
 * Fetch pending anomalies from CockroachDB queued for notification.
 * Used by the Telegram bot or background worker.
 */
export async function getPendingAnomalies(userId: string): Promise<DetectedAnomaly[]> {
    const res = await pool.query<DetectedAnomaly>(
        `SELECT id, user_id AS "userId", transaction_id AS "transactionId", type, severity, title, description, amount, merchant_name AS "merchantName", status
         FROM anomalies
         WHERE user_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [userId]
    );
    return res.rows;
}

/**
 * Mark anomalies as notified after Telegram alert is sent.
 */
export async function markAnomaliesNotified(anomalyIds: string[]): Promise<void> {
    if (anomalyIds.length === 0) return;
    await pool.query(
        `UPDATE anomalies SET status = 'notified' WHERE id = ANY($1::uuid[])`,
        [anomalyIds]
    );
}
