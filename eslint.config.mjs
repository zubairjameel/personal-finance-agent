// @ts-check
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

// typescript-eslint is skipped for now: it doesn't yet support TypeScript 7
// (https://github.com/typescript-eslint/typescript-eslint/issues/10940).
// `npm run build` (tsc) still fully type-checks the project in the meantime.
export default [
    eslint.configs.recommended,
    {
        languageOptions: {
            globals: globals.node,
        },
    },
    eslintConfigPrettier,
    {
        ignores: ["dist/**", "node_modules/**"],
    },
];
