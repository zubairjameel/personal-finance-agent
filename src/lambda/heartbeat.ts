import { runHeartbeatCycle, type CycleResult } from "../agent/background-loop.ts";
import { loadApplicationSecrets } from "./secrets.ts";

type HeartbeatRunner = () => Promise<CycleResult>;

export function createHeartbeatHandler(runCycle: HeartbeatRunner = runHeartbeatCycle) {
    return async (): Promise<{ statusCode: number; body: string }> => {
        await loadApplicationSecrets();
        const result = await runCycle();
        return {
            statusCode: result.errors.length === 0 ? 200 : 207,
            body: JSON.stringify(result),
        };
    };
}

export const handler = createHeartbeatHandler();
