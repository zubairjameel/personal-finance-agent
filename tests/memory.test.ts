import assert from "node:assert/strict";
import test from "node:test";
import {
    decideMemoryAction,
    MEMORY_DISTANCE_THRESHOLD,
    saveAgentMemory,
    type AgentMemoryRecord,
    type MemoryDependencies,
} from "../src/ai/outcome-memory.ts";

const baseRecord: AgentMemoryRecord = {
    id: "memory-1",
    userId: "user-1",
    queryText: "past question",
    recommendation: "past recommendation",
    outcome: "success",
    feedbackNotes: null,
    distance: MEMORY_DISTANCE_THRESHOLD - 0.01,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
};

function dependencies(record: AgentMemoryRecord): MemoryDependencies {
    return {
        embed: async () => new Array<number>(768).fill(0.25),
        query: async <T>() => ({ rows: [record as T] }),
    };
}

test("verified successful precedent produces REUSE", async () => {
    const decision = await decideMemoryAction("user-1", "question", dependencies(baseRecord));
    assert.equal(decision.action, "REUSE");
});

test("failed precedent produces ABSTAIN", async () => {
    const decision = await decideMemoryAction(
        "user-1",
        "question",
        dependencies({ ...baseRecord, outcome: "failed" }),
    );
    assert.equal(decision.action, "ABSTAIN");
});

test("embedding failure is explicit and does not save a fake vector", async () => {
    let queried = false;
    const failing: MemoryDependencies = {
        embed: async () => { throw new Error("provider unavailable"); },
        query: async <T>() => { queried = true; return { rows: [] as T[] }; },
    };
    await assert.rejects(
        saveAgentMemory("user-1", "question", "answer", "pending", null, failing),
        /provider unavailable/,
    );
    assert.equal(queried, false);
});
