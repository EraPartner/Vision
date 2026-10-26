import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { checkRows } from "./rowContracts.ts";

/** One `db/schema-inventory.sql` row (`kind, name, definition`). */
export interface SchemaInventoryObject {
  kind: string;
  name: string;
  definition: unknown[];
}

const schemaInventoryObjectSchema = z
  .object({
    kind: z.string(),
    name: z.string(),
    definition: z.array(z.unknown()),
  })
  .describe("schema inventory row");

export type SchemaInventoryEntry = [
  kind: string,
  name: string,
  definition: unknown[],
];

type RunQuery = (
  text: string,
) => Promise<{ rows: SchemaInventoryObject[] } | { rows: unknown[] }>;

// pg_dump restores this CHECK with a different but equivalent ARRAY spelling.
const equivalentDividendChecks: ReadonlySet<unknown> = new Set([
  "CHECK (((dividend_amount_convention)::text = ANY ((ARRAY['gross'::character varying, 'net'::character varying, 'unknown'::character varying])::text[])))",
  "CHECK (((dividend_amount_convention)::text = ANY (ARRAY[('gross'::character varying)::text, ('net'::character varying)::text, ('unknown'::character varying)::text])))",
]);

export function readSchemaInventorySql(repoRoot: string): string {
  return readFileSync(path.join(repoRoot, "db", "schema-inventory.sql"), "utf8");
}

/** Column order and the known equivalent CHECK spelling do not count as drift. */
export function normalizeSchemaInventory(
  objects: SchemaInventoryObject[],
): SchemaInventoryEntry[] {
  const normalized = objects.map(
    ({ kind, name, definition }): SchemaInventoryEntry => {
      const value = [...definition];
      if (kind === "column") value[0] = 0;
      if (
        kind === "constraint" &&
        name ===
          "public.portfolio_transactions.chk_portfolio_transactions_dividend_amount_convention" &&
        equivalentDividendChecks.has(value[4])
      ) {
        value[4] = "CHECK dividend_amount_convention IN (gross,net,unknown)";
      }
      return [kind, name, value];
    },
  );
  normalized.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return normalized;
}

export function schemaFingerprint(entries: SchemaInventoryEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Read the normalized catalog inventory. Never reads row data. */
export async function readSchemaInventory(
  runQuery: RunQuery,
  repoRoot: string,
): Promise<SchemaInventoryEntry[]> {
  const result = await runQuery(readSchemaInventorySql(repoRoot));
  return normalizeSchemaInventory(
    checkRows(schemaInventoryObjectSchema, result.rows),
  );
}
