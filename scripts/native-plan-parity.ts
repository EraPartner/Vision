#!/usr/bin/env bun
/**
 * Re-records the plan corpus of the Swift backend (ADR-270 decision 5): each line of
 * apps/native/parity/plans/portfolio-import-reconciliation.jsonl holds one input of the
 * pure `buildPortfolioImportReconciliationPlan` and what it answered (or the message it
 * threw). The inputs were captured from the planner's unit tests and from the import
 * pipeline in the database tests, plus mutations of them that reach outcomes those tests
 * do not; columns the planner never reads are left out. This script keeps the inputs and
 * rewrites the answers. The file stays under the repository's 1 MB limit.
 *
 *   bun run native:parity-plans            # rewrite the answers
 *   bun run native:parity-plans -- --check # fail if an answer would change
 *
 * import-interop.jsonl beside it samples the JavaScript behaviours the planner leans on
 * (decimal.js, csv-parse, `Date.parse`, identity text), re-evaluated the same way.
 *
 * The Swift test (VisionBackendTests/PortfolioImportPlanParityTests.swift) builds the same
 * inputs and compares the same projection, ignoring key order. Sets are recorded as arrays
 * and `historySourceIds` as its entries.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildPortfolioImportReconciliationPlan } from "../apps/node-backend/src/services/portfolioImportReconciliationService.ts";
import { normalizeIdentityText } from "../apps/node-backend/src/services/importIdentity.ts";
import { toDecimal } from "../packages/shared-utils/src/money.ts";
import type { ReconciliationPlanInput } from "../apps/node-backend/src/services/portfolioImportReconciliationService.ts";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import { repoPath } from "./lib/nativeCodegen.ts";

// The backend's own csv-parse: this script's folder has no dependencies of its own.
const { parse } = createRequire(repoPath("apps/node-backend/package.json"))("csv-parse/sync") as {
  parse: (input: string, options: { relax_quotes: boolean; relax_column_count: boolean }) => string[][];
};
/** `new Decimal(text)` on the decimal.js the money module configured; `toDecimal` alone reads "" as 0. */
const decimal = (text: string) => {
  if (text === "") throw new Error("[DecimalError] Invalid argument: ");
  return toDecimal(text);
};
/** decimal.js `ROUND_HALF_UP` and `ROUND_HALF_EVEN`. */
const HALF_UP = 4;
const HALF_EVEN = 6;

const CORPUS = repoPath("apps/native/parity/plans/portfolio-import-reconciliation.jsonl");
/** `{ op, r }` lines: see `evaluate`. */
const INTEROP = repoPath("apps/native/parity/plans/import-interop.jsonl");

/** The columns of an adoption image the corpus compares, `null` when missing. */
const IMAGE_COLUMNS = [
  "id",
  "investment_id",
  "type",
  "date",
  "amount",
  "units",
  "price_per_unit",
  "fees",
  "taxes",
  "currency",
  "fx_rate_to_eur",
  "dividend_amount_convention",
  "account_id",
  "note",
  "import_batch_id",
  "source_record_hash",
  "dedup_fingerprint",
  "dedup_fingerprint_version",
] as const;

type Wire = Record<string, unknown> & {
  crossFormat?: Record<string, unknown> & {
    cashFingerprints: string[];
    correctedAliases: string[];
    settledIdentities: string[];
  };
  historySourceIds?: [number, string[]][];
};

function planInput(wire: Wire): ReconciliationPlanInput {
  const context = wire.crossFormat;
  // The recorded rows are wire-shaped (plain ids and currencies), as the tests pass them.
  return {
    ...wire,
    crossFormat: context && {
      ...context,
      cashFingerprints: new Set(context.cashFingerprints),
      correctedAliases: new Set(context.correctedAliases),
      settledIdentities: new Set(context.settledIdentities),
    },
    historySourceIds: wire.historySourceIds && new Map(wire.historySourceIds),
  } as unknown as ReconciliationPlanInput;
}

const image = (snapshot: object) =>
  Object.fromEntries(
    IMAGE_COLUMNS.map((column) => [column, (snapshot as Record<string, unknown>)[column] ?? null]),
  );

export function record(wire: Wire): { input: Wire; result?: unknown; error?: string } {
  try {
    const answer = buildPortfolioImportReconciliationPlan(planInput(wire));
    return {
      input: wire,
      result: {
        plan: answer.plan,
        adoptions: answer.adoptions.map((adoption) => ({
          rowId: Number(adoption.row.id),
          policy: adoption.policy,
          before: image(adoption.before),
          after: image(adoption.after),
        })),
        settledDuplicates: answer.settledDuplicates.map((row) => Number(row.id)),
        cashAdoptions: answer.cashAdoptions.map((adoption) => ({
          rowId: Number(adoption.row.id),
          decision: adoption.decision,
        })),
      },
    };
  } catch (error) {
    return { input: wire, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One JavaScript behaviour the planner depends on (decimal.js at the money module's
 * settings, csv-parse, `Date.parse`, the identity text rule), evaluated for one input.
 * `"error"` stands for a thrown error.
 */
export function evaluate(op: readonly unknown[]): unknown {
  const [name, ...args] = op;
  const text = (index: number) => String(args[index]);
  try {
    switch (name) {
      case "new":
        return decimal(text(0)).toFixed();
      case "fromNumber":
        return toDecimal(Number(args[0])).toFixed();
      case "plus":
        return decimal(text(0)).plus(decimal(text(1))).toFixed();
      case "minus":
        return decimal(text(0)).minus(decimal(text(1))).toFixed();
      case "times":
        return decimal(text(0)).times(decimal(text(1))).toFixed();
      case "div": {
        const quotient = decimal(text(0)).dividedBy(decimal(text(1)));
        return quotient.isFinite() ? quotient.toFixed() : "error";
      }
      case "dp":
        return decimal(text(0))
          .toDecimalPlaces(Number(args[1]), args[2] === "up" ? HALF_UP : HALF_EVEN)
          .toFixed();
      case "cmp":
        return decimal(text(0)).cmp(decimal(text(1)));
      case "num":
        return String(decimal(text(0)).toNumber());
      case "day":
        return String(Date.parse(`${text(0)}T00:00:00Z`) / 86_400_000);
      case "csv":
        return parse(text(0), { relax_quotes: args[1] === true, relax_column_count: args[2] === true });
      case "identity":
        return normalizeIdentityText(text(0));
      default:
        throw new Error(`unknown op ${String(name)}`);
    }
  } catch (error) {
    if (name === undefined || (error instanceof Error && error.message.startsWith("unknown op"))) throw error;
    return "error";
  }
}

function rerecord(file: string, line: (recorded: string) => unknown, check: boolean): void {
  const recorded = fs.readFileSync(file, "utf8");
  const next = recorded
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => `${JSON.stringify(line(text))}\n`)
    .join("");
  if (!check) fs.writeFileSync(file, next);
  else if (next !== recorded) {
    console.error(`${file} is stale: run \`bun run native:parity-plans\``);
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) {
  const check = process.argv.includes("--check");
  rerecord(CORPUS, (text) => record((JSON.parse(text) as { input: Wire }).input), check);
  rerecord(
    INTEROP,
    (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: evaluate(op) };
    },
    check,
  );
}
