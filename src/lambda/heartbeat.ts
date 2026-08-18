import { runHeartbeatCycle, type CycleResult } from "../agent/background-loop.ts";
import { loadApplicationSecrets } from "./secrets.ts";

type HeartbeatRunner = () => Promise<CycleResult>;
type SecretsLoader = (requiredKeys?: readonly string[]) => Promise<void>;

export function createHeartbeatHandler(
    runCycle: HeartbeatRunner = runHeartbeatCycle,
    loadSecrets: SecretsLoader = loadApplicationSecrets,
) {
    return async (): Promise<{ statusCode: number; body: string }> => {
        await loadSecrets(["DATABASE_URL"]);
        const result = await runCycle();
        return {
            statusCode: result.errors.length === 0 ? 200 : 207,
            body: JSON.stringify(result),
        };
    };
}

export const handler = createHeartbeatHandler();
