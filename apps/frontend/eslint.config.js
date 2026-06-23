import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
    // coverage/ is an istanbul build artifact — linting it produced six
    // "unused eslint-disable" warnings from generated files.
    { ignores: ["../../dist", "coverage"] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            ecmaVersion: 2020,
            globals: globals.browser,
        },
        plugins: {
            "react-hooks": reactHooks,
            "react-refresh": reactRefresh,
        },
        rules: {
            // React Hooks v4 rules (kept as-is)
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            // New v7 rules — disabled until code is migrated to comply
            "react-hooks/static-components": "off",
            "react-hooks/use-memo": "off",
            "react-hooks/preserve-manual-memoization": "off",
            "react-hooks/incompatible-library": "off",
            "react-hooks/immutability": "off",
            "react-hooks/globals": "off",
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
            "react-hooks/error-boundaries": "off",
            "react-hooks/purity": "off",
            "react-hooks/set-state-in-render": "off",
            "react-hooks/unsupported-syntax": "off",
            "react-hooks/config": "off",
            "react-hooks/gating": "off",
            "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
            // Warn on unused vars/imports; prefix with _ to intentionally suppress (e.g. _unused)
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        },
    },
    {
        // Test harness helpers legitimately export non-component utilities next
        // to wrapper components; fast refresh never applies under vitest.
        files: ["src/test/**/*.{ts,tsx}"],
        rules: { "react-refresh/only-export-components": "off" },
    },
);
