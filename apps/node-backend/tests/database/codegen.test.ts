/**
 * The committed Kysely types and write-plugin column map must equal what
 * scripts/db-codegen.ts generates from the migrations (ADR-226, ADR-263), so a
 * migration cannot land without its regenerated types.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateSchemaFiles } from "../../scripts/db-codegen.ts";

const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");

describe("generated schema files", () => {
  const { schema, map, config } = generateSchemaFiles();

  it.each([
    [config.outFile, schema],
    [config.mapFile, map],
  ])("%s matches the migrations (run `bun run db:codegen`)", (file, text) => {
    expect(readFileSync(path.join(BACKEND_ROOT, file), "utf8")).toBe(text);
  });
});
