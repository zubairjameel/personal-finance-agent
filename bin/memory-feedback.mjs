/**
 * bin/memory-feedback.mjs
 *
 * Kadmus Outcome-Verified Memory Feedback CLI.
 *
 * Allows users and developers to review agent memories stored in CockroachDB
 * and verify their real-world outcomes ('success', 'failed', 'revoked').
 *
 * Usage:
 *   npm run memory:list                                   ← List recent memories
 *   npm run memory:feedback -- --id=<UUID> --outcome=failed --notes="High fee incurred"
 *   npm run memory:feedback -- --id=<UUID> --outcome=success
 */

import { config } from "dotenv";
import { getOrCreateUser, pool } from "../src/db/index.ts";
import { listRecentMemories, updateMemoryOutcome } from "../src/ai/outcome-memory.ts";

config({ path: ".env.local" });

const c = {
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
};

async function main() {
    const user = await getOrCreateUser();

    // Parse flags
    const idArg = process.argv.find((a) => a.startsWith("--id="))?.split("=")[1];
    const outcomeArg = process.argv.find((a) => a.startsWith("--outcome="))?.split("=")[1];
    const notesArg = process.argv.find((a) => a.startsWith("--notes="))?.split("=")[1];

    if (idArg && outcomeArg) {
        // Update outcome
        const validOutcomes = ["pending", "success", "failed", "revoked"];
        if (!validOutcomes.includes(outcomeArg.toLowerCase())) {
            console.error(c.red(`❌ Invalid outcome. Must be one of: ${validOutcomes.join(", ")}`));
            process.exit(1);
        }

        const updated = await updateMemoryOutcome(idArg, outcomeArg.toLowerCase(), notesArg);
        if (updated) {
            console.log(c.green(`\n✓ Memory ${idArg} marked as '${outcomeArg.toUpperCase()}' in CockroachDB.`));
            if (notesArg) console.log(c.dim(`  Feedback Notes: "${notesArg}"`));
        } else {
            console.error(c.red(`\n❌ Memory ID ${idArg} not found.`));
        }
        await pool.end();
        process.exit(0);
    }

    // Default: List recent memories
    console.log(c.cyan("═".repeat(70)));
    console.log(c.bold("🧠 KADMUS OUTCOME-VERIFIED AGENTIC MEMORY (CockroachDB Vector Core)"));
    console.log(c.cyan("═".repeat(70)) + "\n");

    const memories = await listRecentMemories(user.id, 10);

    if (memories.length === 0) {
        console.log(c.dim("No agent memories recorded yet. Ask Kadmus a question with `npm run analysis` first!\n"));
        await pool.end();
        process.exit(0);
    }

    for (const m of memories) {
        const badge =
            m.outcome === "success"
                ? c.green(`[SUCCESS]`)
                : m.outcome === "failed"
                  ? c.red(`[FAILED]`)
                  : m.outcome === "revoked"
                    ? c.yellow(`[REVOKED]`)
                    : c.dim(`[PENDING]`);

        console.log(`• ${badge} ${c.bold(m.queryText)}`);
        console.log(`  ID: ${c.dim(m.id)} | Date: ${c.dim(new Date(m.createdAt).toLocaleString())}`);
        if (m.feedbackNotes) console.log(`  Notes: ${c.yellow(`"${m.feedbackNotes}"`)}`);
        console.log(`  Recommendation: ${c.dim(m.recommendation.slice(0, 140))}...\n`);
    }

    console.log(c.dim("To update memory outcome for demo testing:"));
    console.log(c.cyan('  npm run memory:feedback -- --id=<ID> --outcome=success'));
    console.log(c.cyan('  npm run memory:feedback -- --id=<ID> --outcome=failed --notes="Early cancellation fee"\n'));

    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
