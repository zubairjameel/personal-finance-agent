export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export function resolveGeminiModel(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return environment["GEMINI_MODEL"]?.trim() || DEFAULT_GEMINI_MODEL;
}
