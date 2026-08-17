/**
 * src/ai/outcome-memory.ts
 *
 * Outcome-Verified Agentic Memory Layer for Kadmus.
 *
 * Implements CockroachDB Distributed Vector Indexing & Memory Safety:
 * 1. Stores recommendations with 768-dim embeddings in CockroachDB `agent_memory`.
 * 2. Vector similarity search (<-> distance) on new user questions.
 * 3. Outcome verification:
 *    • If previous outcome was SUCCESS  → REUSE past verified precedent.
 *    • If previous outcome was FAILED   → ABSTAIN, warn user, run fresh analysis.
 *    • If no precedent exists           → FRESH_ANALYSIS & save to memory.
 */

import { pool } from "../db/index.ts";
import { getEmbedding, formatVectorForCockroach } from "./embeddings.ts";

export type MemoryOutcome = "pending" | "success" | "failed" | "revoked";

export interface AgentMemoryRecord {
    id: string;
    userId: string;
    queryText: string;
    recommendation: string;
    outcome: MemoryOutcome;
    feedbackNotes: string | null;
    distance?: number;
    createdAt: string;
    updatedAt: string;
}

export type MemoryDecision =
    | { action: "REUSE"; memory: AgentMemoryRecord; reason: string }
    | { action: "ABSTAIN"; memory: AgentMemoryRecord; reason: string }
    | { action: "FRESH_ANALYSIS"; memory: null; reason: string };

/**
 * Save a new query + recommendation into CockroachDB with its 768-dim vector embedding.
 */
export async function saveAgentMemory(
    userId: string,
    queryText: string,
    recommendation: string,
    outcome: MemoryOutcome = "pending",
    feedbackNotes: string | null = null,
): Promise<AgentMemoryRecord> {
    let vectorSql: string | null = null;

    try {
        const embedding = await getEmbedding(queryText);
        vectorSql = formatVectorForCockroach(embedding);
    } catch (err) {
        console.warn(`[Memory] Embedding generation failed: ${err instanceof Error ? err.message : String(err)} — saving memory without vector.`);
    }

    const query = vectorSql
        ? `INSERT INTO agent_memory (user_id, query_text, recommendation, embedding, outcome, feedback_notes)
           VALUES ($1, $2, $3, $4::VECTOR(768), $5, $6)
           RETURNING id, user_id AS "userId", query_text AS "queryText", recommendation, outcome, feedback_notes AS "feedbackNotes", created_at AS "createdAt", updated_at AS "updatedAt"`
        : `INSERT INTO agent_memory (user_id, query_text, recommendation, outcome, feedback_notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id AS "userId", query_text AS "queryText", recommendation, outcome, feedback_notes AS "feedbackNotes", created_at AS "createdAt", updated_at AS "updatedAt"`;

    const params = vectorSql
        ? [userId, queryText, recommendation, vectorSql, outcome, feedbackNotes]
        : [userId, queryText, recommendation, outcome, feedbackNotes];

    const res = await pool.query<AgentMemoryRecord>(query, params);
    return res.rows[0]!;
}

/**
 * Search CockroachDB for the most semantically similar previous agent memory.
 * Uses CockroachDB L2 vector distance `<->`.
 */
export async function searchSimilarMemory(
    userId: string,
    queryText: string,
    distanceThreshold: number = 1.10,
): Promise<AgentMemoryRecord | null> {
    let embedding: number[];
    try {
        embedding = await getEmbedding(queryText);
    } catch {
        return null;
    }

    const vectorSql = formatVectorForCockroach(embedding);

    const res = await pool.query<AgentMemoryRecord>(
        `SELECT 
            id,
            user_id AS "userId",
            query_text AS "queryText",
            recommendation,
            outcome,
            feedback_notes AS "feedbackNotes",
            (embedding <-> $1::VECTOR(768)) AS distance,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
         FROM agent_memory
         WHERE user_id = $2 AND embedding IS NOT NULL
         ORDER BY embedding <-> $1::VECTOR(768)
         LIMIT 1`,
        [vectorSql, userId],
    );

    const match = res.rows[0];
    if (!match) return null;

    // Check distance threshold (lower is closer in L2 space)
    if (typeof match.distance === "number" && match.distance <= distanceThreshold) {
        return match;
    }

    return null;
}

/**
 * Core Decision Engine: Decide whether to REUSE, ABSTAIN, or run a FRESH analysis.
 */
export async function decideMemoryAction(
    userId: string,
    queryText: string,
): Promise<MemoryDecision> {
    const similar = await searchSimilarMemory(userId, queryText);

    if (!similar) {
        return {
            action: "FRESH_ANALYSIS",
            memory: null,
            reason: "No similar past precedent found in CockroachDB memory.",
        };
    }

    // Outcome: SUCCESS → Safe to reuse verified precedent
    if (similar.outcome === "success") {
        return {
            action: "REUSE",
            memory: similar,
            reason: `Found verified successful precedent from ${new Date(similar.createdAt).toLocaleDateString()} (distance: ${similar.distance?.toFixed(3)}). Reusing verified recommendation.`,
        };
    }

    // Outcome: FAILED or REVOKED → ABSTAIN from repeating bad advice!
    if (similar.outcome === "failed" || similar.outcome === "revoked") {
        return {
            action: "ABSTAIN",
            memory: similar,
            reason: `Found similar precedent from ${new Date(similar.createdAt).toLocaleDateString()}, but its verified outcome was '${similar.outcome.toUpperCase()}'${similar.feedbackNotes ? ` (${similar.feedbackNotes})` : ""}. Abstaining from reusing failed advice.`,
        };
    }

    // Outcome: PENDING → Precedent not verified yet; do fresh analysis
    return {
        action: "FRESH_ANALYSIS",
        memory: null,
        reason: `Found past precedent but outcome is still 'pending' verification. Running fresh analysis.`,
    };
}

/**
 * Update the outcome status and feedback notes for a memory record.
 */
export async function updateMemoryOutcome(
    memoryId: string,
    outcome: MemoryOutcome,
    feedbackNotes?: string,
): Promise<boolean> {
    const res = await pool.query(
        `UPDATE agent_memory 
         SET outcome = $1, 
             feedback_notes = COALESCE($2, feedback_notes), 
             updated_at = now() 
         WHERE id = $3`,
        [outcome, feedbackNotes ?? null, memoryId],
    );
    return (res.rowCount ?? 0) > 0;
}

/**
 * List all recent memories stored in CockroachDB for a given user.
 */
export async function listRecentMemories(
    userId: string,
    limit: number = 10,
): Promise<AgentMemoryRecord[]> {
    const res = await pool.query<AgentMemoryRecord>(
        `SELECT id, user_id AS "userId", query_text AS "queryText", recommendation, outcome, feedback_notes AS "feedbackNotes", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM agent_memory
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit],
    );
    return res.rows;
}
