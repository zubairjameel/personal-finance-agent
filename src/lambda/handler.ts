import { runHeartbeatCycle } from "../agent/background-loop.ts";
import { pool } from "../db/index.ts";

export interface LambdaResult {
    statusCode: number;
    body: string;
}

export const handler = async (): Promise<LambdaResult> => {
    console.log("[lambda] Starting heartbeat cycle");

    try {
        const result = await runHeartbeatCycle();

        console.log("[lambda] Heartbeat cycle completed", {
            cycleNumber: result.cycleNumber,
            newAnomalies: result.newAnomalies,
            pendingAlerts: result.pendingAlerts,
            errorCount: result.errors.length,
        });

        return {
            statusCode: 200,
            body: JSON.stringify(result),
        };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : String(error);

        console.error("[lambda] Unexpected error", error);

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: message,
            }),
        };
    } finally {
        try {
            await pool.end();
        } catch {
            // Ignore already-closed pools.
        }
    }
};