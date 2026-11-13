import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { repoPath } from "../lib/nativeCodegen.ts";
import { OUTPUT, generateTaxTables } from "../native-tax-tables.ts";

void test("the committed Swift tax tables match the TypeScript ones", () => {
  assert.equal(
    fs.readFileSync(repoPath(OUTPUT), "utf8"),
    generateTaxTables(),
    "run `bun run native:generate-tax-tables`",
  );
});
