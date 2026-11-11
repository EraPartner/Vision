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
 * analysis-formulas.jsonl holds requests of `evaluateAnalysisFormulas` (captured from the
 * analysis tests, written by hand for the edges, and generated) with its answer or error, and
 * belgian-tax.jsonl holds calls of the Belgian tax engine (packages/shared-utils/src/belgianTax):
 * households for `computeHouseholdTax`, the profile and household conversions, the settings
 * loader, the overview and the portfolio tax dashboard, captured from the engine's tests and
 * generated, thinned to stay under the repository's file-size limit.
 * analysis-sql-rules.jsonl holds analysis SQL (the cases of the executor's tests and generated
 * text) with what `checkAnalysisSql`, `scanSql` and the column-type rules answer.
 *
 * foundations.jsonl samples the shared helpers (money, number rendering, `lib/math.ts`,
 * `lib/timezone.ts`).
 *
 * The Swift test (VisionBackendTests/PortfolioImportPlanParityTests.swift) builds the same
 * inputs and compares the same projection, ignoring key order. Sets are recorded as arrays
 * and `historySourceIds` as its entries.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildPortfolioImportReconciliationPlan } from "../apps/node-backend/src/services/portfolioImportReconciliationService.ts";
import {
  AnalysisFormulaError,
  evaluateAnalysisFormulas,
} from "../apps/node-backend/src/services/analysisFormulaEngine.ts";
import type { EvaluateAnalysisFormulasInput } from "../apps/node-backend/src/services/analysisFormulaEngine.ts";
import { normalizeIdentityText } from "../apps/node-backend/src/services/importIdentity.ts";
import {
  addAll,
  numericColumn,
  roundMoney,
  roundToCents,
  toDecimal,
} from "../packages/shared-utils/src/money.ts";
import {
  isRobustNeedle,
  madReturnStats,
  median,
} from "../apps/node-backend/src/lib/math.ts";
import { epochMsToUtcYmd } from "../apps/node-backend/src/lib/dateFormat.ts";
import {
  addDaysYmd,
  appDateStringToUtc,
  differenceInCalendarDaysYmd,
  firstOfMonthYmd,
  toAppDateString,
  toAppTz,
  toUtc,
  ymdToEpochDay,
} from "../apps/node-backend/src/lib/timezone.ts";
import { filesJointly } from "../packages/shared-utils/src/belgianTax/assessment.ts";
import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "../packages/shared-utils/src/belgianTax/household.ts";
import {
  applyProfileV1PatchToHousehold,
  projectHouseholdToProfileV1,
  upgradeProfileV1ToHousehold,
  upgradeSnapshotsV1ToV2,
} from "../packages/shared-utils/src/belgianTax/householdMigration.ts";
import { buildTaxOverview } from "../packages/shared-utils/src/belgianTax/overview.ts";
import { buildPortfolioTaxDashboard } from "../packages/shared-utils/src/belgianTax/portfolioDashboard.ts";
import {
  attributeToPartners,
  householdForRecordedIncome,
} from "../packages/shared-utils/src/belgianTax/recordedIncomeAttribution.ts";
import { loadHouseholdSettings } from "../packages/shared-utils/src/belgianTax/settings.ts";
import { estimateSelfEmployedContributions } from "../packages/shared-utils/src/belgianTax/socialSecurity.ts";
import { getTaxTable } from "../packages/shared-utils/src/belgianTax/constants.ts";
import type { ReconciliationPlanInput } from "../apps/node-backend/src/services/portfolioImportReconciliationService.ts";
import {
  __analysisSqlRules,
  __validateAnalysisSql,
} from "../apps/node-backend/src/services/analysisExecutor.ts";
import { scanSql } from "../apps/node-backend/src/database/sqlite/sqlText.ts";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import { repoPath } from "./lib/nativeCodegen.ts";

// The backend's own csv-parse: this script's folder has no dependencies of its own.
const { parse } = createRequire(repoPath("apps/node-backend/package.json"))(
  "csv-parse/sync",
) as {
  parse: (
    input: string,
    options: { relax_quotes: boolean; relax_column_count: boolean },
  ) => string[][];
};
/** `new Decimal(text)` on the decimal.js the money module configured; `toDecimal` alone reads "" as 0. */
const decimal = (text: string) => {
  if (text === "") throw new Error("[DecimalError] Invalid argument: ");
  return toDecimal(text);
};
/** `Decimal.sum` of that same decimal.js. */
const DecimalSum = toDecimal(0).constructor as unknown as {
  sum: (
    ...values: ReturnType<typeof toDecimal>[]
  ) => ReturnType<typeof toDecimal>;
};
/** decimal.js `ROUND_HALF_UP` and `ROUND_HALF_EVEN`. */
const HALF_UP = 4;
const HALF_EVEN = 6;

const CORPUS = repoPath(
  "apps/native/parity/plans/portfolio-import-reconciliation.jsonl",
);
/** `{ input, result | error }` lines of `evaluateAnalysisFormulas`. */
const FORMULAS = repoPath("apps/native/parity/plans/analysis-formulas.jsonl");
/** `{ op, r }` lines: see `evaluateFoundation`. */
const FOUNDATIONS = repoPath("apps/native/parity/plans/foundations.jsonl");
/** `{ op, r }` lines: see `evaluate`. */
const TAX = repoPath("apps/native/parity/plans/belgian-tax.jsonl");

const SQL_RULES = repoPath("apps/native/parity/plans/analysis-sql-rules.jsonl");
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
    IMAGE_COLUMNS.map((column) => [
      column,
      (snapshot as Record<string, unknown>)[column] ?? null,
    ]),
  );

export function record(wire: Wire): {
  input: Wire;
  result?: unknown;
  error?: string;
} {
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
        settledDuplicates: answer.settledDuplicates.map((row) =>
          Number(row.id),
        ),
        cashAdoptions: answer.cashAdoptions.map((adoption) => ({
          rowId: Number(adoption.row.id),
          decision: adoption.decision,
        })),
      },
    };
  } catch (error) {
    return {
      input: wire,
      error: error instanceof Error ? error.message : String(error),
    };
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
      case "new": {
        const value = decimal(text(0));
        return value.isFinite() ? value.toFixed() : value.toString();
      }
      case "pow": {
        const power = decimal(text(0)).pow(decimal(text(1)));
        return power.isFinite() ? power.toFixed() : "error";
      }
      case "sqrt":
        return decimal(text(0)).sqrt().toFixed();
      case "sum":
        return DecimalSum.sum(
          ...args.map((_, index) => decimal(text(index))),
        ).toFixed();
      case "text":
        return decimal(text(0)).toString();
      case "fromNumber":
        return toDecimal(Number(args[0])).toFixed();
      case "plus":
        return decimal(text(0))
          .plus(decimal(text(1)))
          .toFixed();
      case "minus":
        return decimal(text(0))
          .minus(decimal(text(1)))
          .toFixed();
      case "times":
        return decimal(text(0))
          .times(decimal(text(1)))
          .toFixed();
      case "div": {
        const quotient = decimal(text(0)).dividedBy(decimal(text(1)));
        return quotient.isFinite() ? quotient.toFixed() : "error";
      }
      case "dp":
        return decimal(text(0))
          .toDecimalPlaces(
            Number(args[1]),
            args[2] === "up" ? HALF_UP : HALF_EVEN,
          )
          .toFixed();
      case "cmp":
        return decimal(text(0)).cmp(decimal(text(1)));
      case "num":
        return String(decimal(text(0)).toNumber());
      case "day":
        return String(Date.parse(`${text(0)}T00:00:00Z`) / 86_400_000);
      case "csv":
        return parse(text(0), {
          relax_quotes: args[1] === true,
          relax_column_count: args[2] === true,
        });
      case "identity":
        return normalizeIdentityText(text(0));
      default:
        throw new Error(`unknown op ${String(name)}`);
    }
  } catch (error) {
    if (
      name === undefined ||
      (error instanceof Error && error.message.startsWith("unknown op"))
    )
      throw error;
    return "error";
  }
}

/**
 * One shared helper the backend builds on (the money helpers, JavaScript number rendering,
 * `lib/math.ts`, `lib/timezone.ts`), evaluated for one input. Numbers travel as text so
 * they stay exact. `"error: …"` stands for a thrown error: the message of a `TypeError`
 * the helper wrote itself, `range` for the engine's `RangeError`.
 */
export function evaluateFoundation(op: readonly unknown[]): unknown {
  const [name, ...args] = op;
  const text = (index: number) => String(args[index]);
  const number = (index: number) => Number(args[index]);
  const numbers = (from: number) => args.slice(from).map(Number);
  try {
    switch (name) {
      case "toFixed":
        return number(0).toFixed(number(1));
      case "toPrecision":
        return number(0).toPrecision(number(1));
      case "round":
        return String(Math.round(number(0)));
      case "roundMoney":
        return String(roundMoney(text(0), number(1)));
      case "roundToCents":
        return roundToCents(text(0)).toFixed();
      case "addAll":
        return addAll(args.map(String)).toFixed();
      case "decimalToFixed":
        return decimal(text(0)).toFixed(
          number(1),
          args[2] === "up" ? HALF_UP : HALF_EVEN,
        );
      case "isInteger":
        return decimal(text(0)).isInteger();
      case "numericColumn": {
        const value = numericColumn(args[0] === null ? null : text(0));
        return value === null || value === undefined ? null : String(value);
      }
      case "median": {
        const value = median(numbers(0));
        return value === undefined ? null : String(value);
      }
      case "returnStatistics": {
        const stats = madReturnStats(numbers(0));
        return [
          stats.medianReturn,
          stats.robustSigma,
          stats.spikeThreshold,
          stats.bridgeThreshold,
          stats.minSpikeMove,
        ].map(String);
      }
      case "needle":
        return isRobustNeedle(
          number(0),
          number(1),
          number(2),
          madReturnStats(numbers(3)),
        );
      case "zoneParts": {
        const parts = toAppTz(new Date(number(0)), text(1));
        return [
          parts.year,
          parts.month,
          parts.day,
          parts.hour,
          parts.minute,
          parts.second,
        ];
      }
      case "zoneInstant":
        return toUtc(
          {
            year: number(1),
            month: number(2),
            day: number(3),
            hour: number(4),
            minute: number(5),
            second: number(6),
          },
          text(0),
        ).getTime();
      case "zoneDay":
        return toAppDateString(new Date(number(0)), text(1));
      case "startOfDay":
        return appDateStringToUtc(text(0), text(1)).getTime();
      case "epochDay":
        return ymdToEpochDay(text(0));
      case "differenceInDays":
        return differenceInCalendarDaysYmd(text(0), text(1));
      case "addDays":
        return addDaysYmd(text(0), number(1));
      case "firstOfMonth":
        return firstOfMonthYmd(text(0), number(1));
      case "utcDay":
        return epochMsToUtcYmd(number(0));
      default:
        throw new Error(`unknown op ${String(name)}`);
    }
  } catch (error) {
    if (error instanceof RangeError) return "error: range";
    if (error instanceof TypeError) return `error: ${error.message}`;
    throw error;
  }
}

/** One formula evaluation: the engine's result, or the error it threw. */
export function recordFormulas(input: unknown): {
  input: unknown;
  result?: unknown;
  error?: unknown;
} {
  try {
    // The recorded inputs are request bodies, which the route passes on as untyped JSON.
    return {
      input,
      result: evaluateAnalysisFormulas(input as EvaluateAnalysisFormulasInput),
    };
  } catch (error) {
    if (error instanceof AnalysisFormulaError)
      return {
        input,
        error: {
          code: error.code,
          message: error.message,
          ...(error.formulaId === null ? {} : { formulaId: error.formulaId }),
        },
      };
    // Any other error is the JavaScript engine's; its message is not part of the contract.
    return {
      input,
      error: { name: error instanceof Error ? error.name : "Error" },
    };
  }
}

/**
 * One call of the Belgian tax engine. The corpus is JSON, so each argument is cast to the
 * type the engine reads it as; an absent optional argument is recorded as null. A `true` in
 * place of the joint-filing check stands for `filesJointly`, and the dashboard's currency
 * conversion is a table of rates (null: no rate known).
 */
export function evaluateTax(op: unknown[]): unknown {
  const [name, a, b, c] = op;
  type Household = Parameters<typeof computeHouseholdTax>[0];
  const optional = (value: unknown): unknown =>
    value === null ? undefined : value;
  const joint = (flag: unknown) => (flag === true ? filesJointly : undefined);
  try {
    switch (name) {
      case "household": {
        const household = a as Household;
        const result = computeHouseholdTax(household);
        return {
          result,
          calculation: toBelgianTaxCalculation(result, household),
        };
      }
      case "upgrade":
        return upgradeProfileV1ToHousehold(a as Household);
      case "upgradeSnapshots":
        return upgradeSnapshotsV1ToV2(
          a as Parameters<typeof upgradeSnapshotsV1ToV2>[0],
        );
      case "project":
        return projectHouseholdToProfileV1(a as Household, joint(b));
      case "patch":
        return applyProfileV1PatchToHousehold(
          a as Household,
          b as Parameters<typeof applyProfileV1PatchToHousehold>[1],
          joint(c),
        );
      case "load":
        return loadHouseholdSettings(
          a as Parameters<typeof loadHouseholdSettings>[0],
        );
      case "overview":
        return buildTaxOverview(
          a as Parameters<typeof buildTaxOverview>[0],
          b as Parameters<typeof buildTaxOverview>[1],
          optional(c) as number | undefined,
        );
      case "attribute":
        return attributeToPartners(
          a as number,
          optional(b) as Parameters<typeof attributeToPartners>[1],
          c as boolean,
        );
      case "recorded":
        return (
          householdForRecordedIncome(
            a as Household | null,
            b as number,
            optional(c) as Parameters<typeof householdForRecordedIncome>[2],
          ) ?? null
        );
      case "selfEmployed":
        return estimateSelfEmployedContributions(
          a as number,
          getTaxTable(b as number),
        );
      case "dashboard": {
        const rates = b as Record<string, number | null | undefined>;
        return buildPortfolioTaxDashboard({
          ...(a as Omit<
            Parameters<typeof buildPortfolioTaxDashboard>[0],
            "convert"
          >),
          convert: (amount, currency) => {
            const rate = rates[currency ?? ""];
            return rate === null || rate === undefined
              ? undefined
              : amount * rate;
          },
        });
      }
      default:
        throw new Error(`unknown op ${String(name)}`);
    }
  } catch (error) {
    if (error instanceof TypeError) return "error: TypeError";
    throw error;
  }
}

/**
 * One call of the analysis SQL rules. A refusal is recorded by its message, which the API
 * returns to the user.
 */
export function evaluateSqlRule(op: unknown[]): unknown {
  const [name, a, b] = op;
  try {
    switch (name) {
      case "check": {
        const sql = __validateAnalysisSql(a, b as string[]);
        return { sql, masked: __analysisSqlRules.maskSql(a as string) };
      }
      case "views":
        return __analysisSqlRules.referencedViews(a as string, b as string[]);
      case "kind":
        return __analysisSqlRules.columnKind(a as string, b as string);
      case "hint":
        return __analysisSqlRules.storedValueHint(a as string);
      case "params":
        return __analysisSqlRules.checkParameters(a);
      case "scan": {
        const scanned = scanSql(a as string);
        return {
          text: scanned.text,
          readOnly: scanned.readOnly,
          multipleStatements: scanned.multipleStatements,
          firstKeyword: scanned.firstKeyword,
        };
      }
      default:
        throw new Error(`unknown SQL rule operation: ${String(name)}`);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function rerecord(
  file: string,
  line: (recorded: string) => unknown,
  check: boolean,
): void {
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
  rerecord(
    CORPUS,
    (text) => record((JSON.parse(text) as { input: Wire }).input),
    check,
  );
  rerecord(
    FORMULAS,
    (text) => recordFormulas((JSON.parse(text) as { input: unknown }).input),
    check,
  );
  rerecord(
    FOUNDATIONS,
    (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: evaluateFoundation(op) };
    },
    check,
  );
  rerecord(
    TAX,
    (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: evaluateTax(op) };
    },
    check,
  );
  rerecord(
    SQL_RULES,
    (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: evaluateSqlRule(op) };
    },
    check,
  );
  rerecord(
    INTEROP,
    (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: evaluate(op) };
    },
    check,
  );
}
