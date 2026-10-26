/**
 * Type-aware lint for the TypeScript projects outside the two app workspaces:
 * the shared packages, the Electron shell and the repo scripts (ADR-253).
 * The repo root has no ESLint install, so the backend workspace's copy is
 * borrowed; `bun run lint:projects` runs it from the root.
 */
import { createRequire } from "node:module";
import { strictTypeAwareRules } from "./config/eslint-type-aware.mjs";

const require = createRequire(new URL("./apps/node-backend/package.json", import.meta.url));
const tseslint = require("typescript-eslint");
const globals = require("globals");

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/out-*/**",
      "**/dist/**",
      "**/dist-demo/**",
      "packaging/electron/native-runtime/**",
      "packaging/electron/resources/**",
      "packaging/electron/resources-demo/**",
    ],
  },
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/*/tests/**/*.ts",
      "packaging/electron/**/*.{ts,mts}",
      "scripts/**/*.ts",
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: [
          "./packages/types/tsconfig.json",
          "./packages/shared-utils/tsconfig.json",
          "./packages/shared-utils/tsconfig.tests.json",
          "./packaging/electron/tsconfig.json",
          "./packaging/electron/tsconfig.preload.json",
          "./scripts/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...strictTypeAwareRules(tseslint),
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
