import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** One `db/schema-inventory.sql` row (`kind, name, definition`). */
export interface SchemaInventoryObject {
  kind: string;
  name: string;
  definition: unknown[];
}

export type SchemaInventoryEntry = [
  kind: string,
  name: string,
  definition: unknown[],
];

export interface SchemaInventoryDiff {
  missing: string[];
  unexpected: string[];
  changed: string[];
}

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
  return normalizeSchemaInventory(result.rows as SchemaInventoryObject[]);
}

/** One object with its definition reduced to a short hash: `[kind, name, hash]`. */
export type HashedInventoryEntry = [kind: string, name: string, hash: string];

/** db/baseline-inventory.json: the 0001 baseline's inventory, hashed. */
export const BASELINE_INVENTORY_FILE = path.join("db", "baseline-inventory.json");

export function hashSchemaInventory(
  entries: SchemaInventoryEntry[],
): HashedInventoryEntry[] {
  return entries.map(([kind, name, definition]) => [
    kind,
    name,
    createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16),
  ]);
}

/** One entry per line, so a regenerated file diffs readably. */
export function formatHashedInventory(entries: HashedInventoryEntry[]): string {
  return `[\n${entries.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`;
}

export function readBaselineInventory(repoRoot: string): HashedInventoryEntry[] {
  return JSON.parse(
    readFileSync(path.join(repoRoot, BASELINE_INVENTORY_FILE), "utf8"),
  ) as HashedInventoryEntry[];
}

/** Object names only, so a report never carries definitions or data. */
export function diffSchemaInventory(
  expected: HashedInventoryEntry[],
  actual: HashedInventoryEntry[],
): SchemaInventoryDiff {
  const key = ([kind, name]: HashedInventoryEntry) => `${kind} ${name}`;
  const expectedByKey = new Map(expected.map((e) => [key(e), e]));
  const actualByKey = new Map(actual.map((e) => [key(e), e]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [k, entry] of expectedByKey) {
    const other = actualByKey.get(k);
    if (!other) missing.push(k);
    else if (JSON.stringify(other) !== JSON.stringify(entry)) changed.push(k);
  }
  const unexpected = [...actualByKey.keys()].filter(
    (k) => !expectedByKey.has(k),
  );
  return {
    missing: missing.sort(),
    unexpected: unexpected.sort(),
    changed: changed.sort(),
  };
}
