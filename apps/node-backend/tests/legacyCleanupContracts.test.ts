import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

describe("legacy cleanup contracts", () => {
  it("keeps backend runtime code independent of the legacy tx_hash columns", () => {
    // Location-independent: any backend source file may move or split, but
    // none may reference the dropped legacy tx_hash columns.
    const srcRoot = resolve(root, "apps/node-backend/src");
    const offenders = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(?:ts|js|mjs)$/.test(file))
      .filter((file) =>
        readFileSync(resolve(srcRoot, file), "utf8").includes("tx_hash"),
      );
    expect(offenders).toEqual([]);
  });

});
