import { defineConfig } from "vitest/config";

// Unit tests of the shared calculations, including the Belgian tax engine the server runs
// (ADR-217). Run with `bun run test:packages` from the repository root.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
