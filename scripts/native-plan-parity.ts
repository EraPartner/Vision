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
 * forecast.jsonl holds generated calls of the cash-flow forecast methods and of the
 * portfolio projection, with the seeded random draws as 32-bit integers.
 *
 * bank-import.jsonl holds calls of the bank statement adapters (`importPipeline/adapters`)
 * over generated statements, of the format detection and of the helpers the adapters share.
 *
 * portfolio-import.jsonl holds calls of the portfolio statement adapters that read CSV: the
 * sample statements of the backend tests and generated ones.
 *
 * workbook.jsonl holds calls of the XLSX reader (`packages/shared-utils/src/xlsx`) on
 * generated documents and archives, of the workbook checks of `portfolioUpload.ts`, and of
 * the Saxo workbook and IBKR funding adapters on generated workbooks.
 *
 * prices.jsonl holds calls of the price layer's rules: history points, provider settings,
 * and the provider strategies over generated provider answers.
 *
 * migrations.jsonl holds calls of the migration runner's rules (`database/migrate.ts`): which
 * files are migrations, what a ledger allows, what a run applies and backs up, the names and
 * pruning of pre-migration copies, the schema fingerprint, and the boolean input.
 *
 * foundations.jsonl samples the shared helpers (money, number rendering, `lib/math.ts`,
 * `lib/timezone.ts`).
 *
 * The Swift test (VisionBackendTests/PortfolioImportPlanParityTests.swift) builds the same
 * inputs and compares the same projection, ignoring key order. Sets are recorded as arrays
 * and `historySourceIds` as its entries.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import {
  fnv1aHash,
  gaussian,
  makeRng,
} from "../apps/node-backend/src/services/calculations/forecast/prng.ts";
import { densifyDailyHistory } from "../apps/node-backend/src/services/calculations/forecast/_densify.ts";
import { isBelgianHoliday } from "../apps/node-backend/src/services/calculations/forecast/holidays/be.ts";
import { walkForwardBacktest } from "../apps/node-backend/src/services/calculations/forecast/backtest.ts";
import * as simpleAverage from "../apps/node-backend/src/services/calculations/forecast/methods/simpleAverage.ts";
import * as weightedAverage from "../apps/node-backend/src/services/calculations/forecast/methods/weightedAverage.ts";
import * as ewma from "../apps/node-backend/src/services/calculations/forecast/methods/ewma.ts";
import * as holtWinters from "../apps/node-backend/src/services/calculations/forecast/methods/holtWinters.ts";
import * as prophetLite from "../apps/node-backend/src/services/calculations/forecast/methods/prophetLite.ts";
import * as monteCarloParametric from "../apps/node-backend/src/services/calculations/forecast/methods/monteCarloParametric.ts";
import * as monteCarloBlockBootstrap from "../apps/node-backend/src/services/calculations/forecast/methods/monteCarloBlockBootstrap.ts";
import * as ensemble from "../apps/node-backend/src/services/calculations/forecast/methods/ensemble.ts";
import { runPortfolioForecast } from "../apps/node-backend/src/services/research/projection/portfolioProjection.ts";
import {
  detectBank,
  getAdapter,
} from "../apps/node-backend/src/services/importPipeline/adapters/index.ts";
import type { CustomTransactionParserConfig } from "../apps/node-backend/src/services/importPipeline/adapters/generic.ts";
import {
  canonicalIban,
  decodeCsvBuffer,
  normalizeIsoCurrency,
  parseAmountField,
  parseCommaDecimal,
  parseCsvText,
  parseCustomAmount,
  parseDateFlexibleUtc,
  parseDateWithFormat,
  parseDayMonthYear,
  parseDecimalSafe,
  rawDataForCsvRecord,
  splitCsvLines,
} from "../apps/node-backend/src/services/importPipeline/adapters/_shared.ts";
import {
  cleanKbcRecipientName,
  cleanRecipientName,
  normalizeToUppercase,
} from "../apps/node-backend/src/lib/textNormalization.ts";
import { ValidationError } from "../apps/node-backend/src/middleware/errorHandler.ts";
import { parseWithConfig as parsePortfolioStatement } from "../apps/node-backend/src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import type { PortfolioParserConfig } from "../apps/node-backend/src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import { normalizeType } from "../apps/node-backend/src/services/portfolioImportPipeline/portfolioTypeNormalizer.ts";
import {
  __isLikelyPortfolioFile,
  detectPortfolioFileFormat,
} from "../apps/node-backend/src/lib/portfolioUpload.ts";
import { detectBankImportFormats } from "../packages/shared-utils/src/bankImportDetection.ts";
import {
  excelSerialToTime,
  isDateFormatTemplate,
  readXlsxWorkbook,
} from "../packages/shared-utils/src/xlsx/workbook.ts";
import { parseXml } from "../packages/shared-utils/src/xlsx/xml.ts";
import {
  assertBoundedWorkbook,
  readIbkrFundingWorkbook,
  readPortfolioWorkbook,
} from "../apps/node-backend/src/lib/portfolioUpload.ts";
import { parseIbkrFundingHistory } from "../apps/node-backend/src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import {
  __toDateOnly,
  countChangedPointPrices,
  dateOnlyToTimestampMs,
  filterPointsByRange,
  isValidPrice,
  needsHistoryRefresh,
  normalizeHistoryPoints,
  toNumber as priceNumber,
} from "../apps/node-backend/src/services/prices/priceCache.ts";
import type {
  PricePoint,
  RawPricePoint,
} from "../apps/node-backend/src/services/prices/priceCache.ts";
import {
  PROVIDERS,
  _parseKinesisTrendlinePoints,
  getHistoricalPriceAt,
  parseCustomHistoryPoints,
  resolveCustomHistoryConfig,
  resolveKinesisConfig,
  resolveYahooSymbol,
  sanitizeKinesisIsolatedSpikes,
} from "../apps/node-backend/src/services/prices/priceProviderRegistry.ts";
import type {
  CustomHistoryConfig,
  InvestmentRow,
} from "../apps/node-backend/src/services/prices/priceProviderRegistry.ts";
import { getYahooClient } from "../apps/node-backend/src/services/prices/yahooClient.ts";
import { DatabaseSync } from "node:sqlite";
import {
  LEDGER_TABLE,
  loadMigrations,
  migrateConnection,
  planMigrations,
  revertLatestMigration,
  runMigrations,
  schemaFingerprint,
  writePreMigrationBackup,
} from "../apps/node-backend/src/database/migrate.ts";
import { booleanInput } from "../apps/node-backend/src/database/sqlite/values.ts";
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
const FORECAST = repoPath("apps/native/parity/plans/forecast.jsonl");
const INTEROP = repoPath("apps/native/parity/plans/import-interop.jsonl");
const BANK_IMPORT = repoPath("apps/native/parity/plans/bank-import.jsonl");
const PRICES = repoPath("apps/native/parity/plans/prices.jsonl");
const MIGRATIONS = repoPath("apps/native/parity/plans/migrations.jsonl");
const WORKBOOK = repoPath("apps/native/parity/plans/workbook.jsonl");
const PORTFOLIO_IMPORT = repoPath(
  "apps/native/parity/plans/portfolio-import.jsonl",
);

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

type DailyHistory = Array<{ date: string; net: number }>;
type ForecastOptions = {
  paths?: number;
  percentiles?: number[];
  seed?: number | string;
  alpha?: number;
};
const FORECAST_METHODS = {
  simple_avg: simpleAverage,
  weighted_avg: weightedAverage,
  ewma,
  holt_winters: holtWinters,
  prophet_lite: prophetLite,
  monte_carlo_parametric: monteCarloParametric,
  monte_carlo_block_bootstrap: monteCarloBlockBootstrap,
};
type ForecastMethodId = keyof typeof FORECAST_METHODS;

/**
 * One call of the cash-flow forecast methods or of the portfolio projection. The random
 * draws are recorded as their 32-bit integers, so the sequence is compared exactly. The
 * projection's dependencies are the recorded summary, snapshots, date and provider data.
 */
export async function evaluateForecast(op: unknown[]): Promise<unknown> {
  const [name, a, b, c, d, e] = op;
  try {
    switch (name) {
      case "hash":
        return fnv1aHash(a as string);
      case "draws": {
        const rng = makeRng(a as number | string);
        return Array.from({ length: b as number }, () => rng() * 0x100000000);
      }
      case "gaussian": {
        const rng = makeRng(a as number | string);
        return Array.from({ length: b as number }, () => gaussian(rng));
      }
      case "densify":
        return densifyDailyHistory(
          a as DailyHistory,
          (b as string | null) ?? undefined,
        );
      case "holiday":
        return isBelgianHoliday(a as string);
      case "method":
        return FORECAST_METHODS[a as ForecastMethodId].forecast({
          history: b as DailyHistory,
          forecastDates: c as string[],
          ...(d as ForecastOptions),
        });
      case "weights":
        return [
          ...ensemble.computeWeights(
            a as Parameters<typeof ensemble.computeWeights>[0],
            b as string[],
          ),
        ];
      case "effective":
        return [
          ...ensemble.effectiveWeights(
            new Map(a as Array<[string, number]>),
            b as string[],
          ),
        ];
      case "ensemble":
        return ensemble.forecast({
          forecastDates: a as string[],
          methodOutputs: b as Parameters<
            typeof ensemble.forecast
          >[0]["methodOutputs"],
          weights: new Map(c as Array<[string, number]>),
        });
      case "backtest":
        return walkForwardBacktest({
          history: a as DailyHistory,
          methods: (b as ForecastMethodId[]).map((id) => ({
            id,
            label: id,
            forecast: FORECAST_METHODS[id].forecast,
          })),
          asOfMonth: c as string,
          windowMonths: d as number,
        });
      case "projection": {
        const providers = (e ?? {}) as Record<
          string,
          Record<string, Record<string, unknown> | undefined> | undefined
        >;
        type Deps = NonNullable<Parameters<typeof runPortfolioForecast>[1]>;
        // The recorded stand-ins carry only the fields the projection reads.
        const deps = {
          getPortfolioSummary: () => Promise.resolve(b),
          getSnapshots: () => Promise.resolve(c),
          today: () => d as string,
          aggregator: {
            fetch: (kind: string, query: { symbol: string }) => {
              const data = providers[query.symbol]?.[kind];
              return Promise.resolve(
                data ? { source: "recorded", data } : { source: "unavailable" },
              );
            },
          },
        } as unknown as Deps;
        return await runPortfolioForecast(
          a as Parameters<typeof runPortfolioForecast>[0],
          deps,
        );
      }
      default:
        throw new Error(`unknown forecast operation: ${String(name)}`);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.name : "Error" };
  }
}

/** A JavaScript number as JSON keeps it: NaN and the infinities by name. */
function numberText(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

/** A parsed date as its day number, `null` when there is none. */
function dayNumber(date: Date | null): number | null {
  return date ? date.getTime() / 86_400_000 : null;
}

/** The failure of a bank import call, by the kind the Swift port tells apart. */
function bankImportFailure(error: unknown): unknown {
  if (error instanceof ValidationError)
    return { error: "validation", message: error.message };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return { error: "csv", code };
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Data contract violated"))
    return { error: "contract" };
  return { error: "failed", message };
}

/**
 * One call of the bank statement adapters or of a helper they share. A statement travels as
 * the base64 of its bytes and is read from a temporary file, as an upload is; dates are
 * recorded as day numbers.
 */
export async function evaluateBankImport(op: unknown[]): Promise<unknown> {
  const [name, a, b, c, d] = op;
  const text = a as string;
  try {
    switch (name) {
      case "bank": {
        const adapter = getAdapter(text);
        if (!adapter) throw new Error(`unknown adapter: ${text}`);
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), "vision-bank-parity-"),
        );
        const file = path.join(directory, "statement.csv");
        try {
          fs.writeFileSync(file, Buffer.from(b as string, "base64"));
          const rows = await adapter.parse(
            file,
            (c ?? undefined) as CustomTransactionParserConfig | undefined,
          );
          return {
            rows: rows.map(({ date, ...row }) => ({
              day: dayNumber(date),
              ...row,
            })),
            ...(rows.skipped !== undefined && { skipped: rows.skipped }),
            ...(rows.excluded !== undefined && { excluded: rows.excluded }),
            ...(rows.issues !== undefined && { issues: rows.issues }),
          };
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
      case "detect":
        return { first: detectBank(text), all: detectBankImportFormats(text) };
      case "adapter":
        return getAdapter(text)?.name ?? null;
      case "records": {
        let skipped = 0;
        const records = parseCsvText<string[] | Record<string, string>>(text, {
          ...(b as Record<string, unknown>),
          on_skip: () => {
            skipped++;
          },
        });
        return {
          records: records.map((record) => ({
            record,
            raw: rawDataForCsvRecord(record),
          })),
          skipped,
        };
      }
      case "decode":
        return decodeCsvBuffer(Buffer.from(text, "base64"), b ?? undefined);
      case "lines":
        return splitCsvLines(text);
      case "decimal":
        return numberText(parseDecimalSafe(text));
      case "commaDecimal":
        return numberText(parseCommaDecimal(text));
      case "amount":
        return numberText(parseAmountField(text));
      case "customAmount":
        return numberText(
          parseCustomAmount(text, b ?? undefined, {
            ...(c !== null && c !== undefined && { rowNumber: c as number }),
            ...(d !== null && d !== undefined && { column: d as string }),
          }),
        );
      case "currency":
        return normalizeIsoCurrency(text);
      case "dayMonthYear":
        return dayNumber(parseDayMonthYear(text));
      case "flexibleDay":
        return dayNumber(parseDateFlexibleUtc(text));
      case "formatDay":
        return dayNumber(parseDateWithFormat(text, b as string));
      case "uppercase":
        return normalizeToUppercase(text);
      case "cleanRecipient":
        return cleanRecipientName(text);
      case "cleanKbcRecipient":
        return cleanKbcRecipientName(text);
      case "iban":
        return canonicalIban(text);
      case "parseInt":
        return numberText(parseInt(text, 10));
      case "parseFloat":
        return numberText(parseFloat(text));
      default:
        throw new Error(`unknown bank import operation: ${String(name)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unknown "))
      throw error;
    return bankImportFailure(error);
  }
}

/** Runs `read` over a temporary file holding the bytes a base64 text names. */
async function withStatementFile<T>(
  base64: string,
  read: (file: string) => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vision-parity-"));
  const file = path.join(directory, "statement");
  try {
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    return await read(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * One call of the portfolio statement adapters (`parseWithConfig`), of the type normaliser
 * or of the upload checks that need no workbook reader. Statements travel as base64 and
 * dates are recorded as day numbers, as for the bank adapters.
 */
export async function evaluatePortfolioImport(op: unknown[]): Promise<unknown> {
  const [name, a, b, c] = op;
  try {
    switch (name) {
      case "portfolio": {
        const rows = await withStatementFile(a as string, (file) =>
          parsePortfolioStatement(file, (b ?? {}) as PortfolioParserConfig),
        );
        return {
          rows: rows.map(({ date, ...row }) => ({
            day: dayNumber(date),
            ...row,
          })),
          ...(rows.skipped !== undefined && { skipped: rows.skipped }),
          ...(rows.sourceColumns !== undefined && {
            sourceColumns: rows.sourceColumns,
          }),
        };
      }
      case "type":
        return normalizeType(a, {
          typeMapping: (b ?? undefined) as Record<string, string> | undefined,
          defaultType: (c ?? undefined) as string | undefined,
        });
      case "format":
        return await withStatementFile(a as string, detectPortfolioFileFormat);
      case "likely":
        return __isLikelyPortfolioFile({
          ...(typeof a === "string" && { originalname: a }),
          ...(typeof b === "string" && { mimetype: b }),
        });
      default:
        throw new Error(`unknown portfolio import operation: ${String(name)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unknown "))
      throw error;
    return bankImportFailure(error);
  }
}

/** A workbook cell for the record: a date as its time value, a number as its raw text. */
function workbookCell(cell: unknown): unknown {
  if (cell instanceof Date) return { date: numberText(cell.getTime()) };
  return cell;
}

/** A parsed portfolio statement with its dates as day numbers. */
function portfolioRows(
  rows: Awaited<ReturnType<typeof parsePortfolioStatement>>,
): unknown {
  return {
    rows: rows.map(({ date, ...row }) => ({ day: dayNumber(date), ...row })),
    ...(rows.skipped !== undefined && { skipped: rows.skipped }),
    ...(rows.sourceColumns !== undefined && {
      sourceColumns: rows.sourceColumns,
    }),
  };
}

/**
 * One call of the workbook reader (`packages/shared-utils/src/xlsx`), of the workbook checks
 * of `portfolioUpload.ts`, or of an adapter that reads a workbook. A workbook travels as
 * base64. The IBKR funding workbook is read by SheetJS, which has no Swift port: its call
 * records the sheets SheetJS read, and the Swift adapter starts from those.
 */
export async function evaluateWorkbook(op: unknown[]): Promise<unknown> {
  const [name, a, b] = op;
  const bytes = () => Buffer.from(a as string, "base64");
  try {
    switch (name) {
      case "xml": {
        const events: unknown[] = [];
        try {
          parseXml(a as string, {
            onOpenTag: (tag, attributes) =>
              events.push(["open", tag, Object.entries(attributes)]),
            onCloseTag: (tag) => events.push(["close", tag]),
            onText: (text) => events.push(["text", text]),
          });
        } catch {
          return { error: "invalid", events };
        }
        return { events };
      }
      case "dateFormat":
        return isDateFormatTemplate(a as string);
      case "serial":
        return numberText(
          new Date(excelSerialToTime(Number(a), b === true)).getTime(),
        );
      case "sheets": {
        let sheets;
        try {
          sheets = await readXlsxWorkbook(new Uint8Array(bytes()), {
            trim: b !== false,
            parseNumber: (raw) => ({ type: "number", raw }),
          });
        } catch {
          return { error: "unreadable" };
        }
        return sheets.map(({ sheet, data }) => ({
          sheet,
          data: data.map((row) => row.map(workbookCell)),
        }));
      }
      case "bounded":
        assertBoundedWorkbook(bytes());
        return true;
      case "portfolioWorkbook": {
        const sheets = await withStatementFile(
          a as string,
          readPortfolioWorkbook,
        );
        return sheets.map(({ sheet, data, sourceFileHash }) => ({
          sheet,
          sourceFileHash,
          data: data.map((row) => row.map(workbookCell)),
        }));
      }
      case "saxo":
        return portfolioRows(
          await withStatementFile(a as string, (file) =>
            parsePortfolioStatement(file, {
              format: "saxo_transaction_history",
            }),
          ),
        );
      case "ibkrFunding":
        return await withStatementFile(a as string, async (file) => {
          let sheets;
          try {
            sheets = await readIbkrFundingWorkbook(file);
          } catch (error) {
            return { reader: bankImportFailure(error) };
          }
          let result;
          try {
            result = portfolioRows(await parseIbkrFundingHistory(file));
          } catch (error) {
            result = bankImportFailure(error);
          }
          return { sheets, result };
        });
      default:
        throw new Error(`unknown workbook operation: ${String(name)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unknown "))
      throw error;
    return bankImportFailure(error);
  }
}

/** A price point for the record: a non-finite number by name. */
function pricePoints(points: readonly PricePoint[]): unknown {
  return points.map((point) => ({
    timestampMs: numberText(point.timestampMs),
    price: numberText(point.price),
  }));
}

/** `undefined` for the `null` a recorded call carries where a bound is absent. */
function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** Runs a provider strategy with `fetch` answering one JSON payload. */
async function withFetchAnswer<T>(
  payload: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * One call of the price layer's rules (`services/prices`): the history point rules of
 * `priceCache.ts`, the settings and payload readers of `priceProviderRegistry.ts`, and the
 * Binance, Yahoo and Kinesis strategies over a given provider answer (no network: `fetch`
 * and the Yahoo client answer the recorded payload).
 */
export async function evaluatePrices(op: unknown[]): Promise<unknown> {
  const [name, a, b, c] = op;
  const points = a as RawPricePoint[] | null | undefined;
  const range = { fromMs: optional(b as number), toMs: optional(c as number) };
  switch (name) {
    case "normalize":
      try {
        return pricePoints(normalizeHistoryPoints(points));
      } catch {
        return { error: "range" };
      }
    case "filter":
      return pricePoints(filterPointsByRange(a as PricePoint[], range));
    case "refresh":
      try {
        return needsHistoryRefresh(points, range);
      } catch {
        return { error: "range" };
      }
    case "changed":
      return countChangedPointPrices(points, b as RawPricePoint[]);
    case "number":
      return optional(priceNumber(a)) ?? null;
    case "valid":
      return isValidPrice(a);
    case "dateOnly":
      try {
        return __toDateOnly(Number(a)) ?? null;
      } catch {
        return { error: "range" };
      }
    case "noon":
      return numberText(dateOnlyToTimestampMs(a as string));
    case "yahooSymbol":
      return resolveYahooSymbol(a as Partial<InvestmentRow>);
    case "customHistory":
      return resolveCustomHistoryConfig(a as Partial<InvestmentRow>);
    case "kinesis":
      return resolveKinesisConfig(a as Partial<InvestmentRow>);
    case "customPoints":
      return pricePoints(parseCustomHistoryPoints(a, b as CustomHistoryConfig));
    case "spikes":
      return pricePoints(sanitizeKinesisIsolatedSpikes(a as PricePoint[]));
    case "trendline":
      return pricePoints(_parseKinesisTrendlinePoints(a));
    case "priceAt":
      return getHistoricalPriceAt(a as PricePoint[], Number(b)) ?? null;
    case "binance":
      return await withFetchAnswer(a, () => PROVIDERS.binance(b as string[]));
    case "yahoo": {
      const client = await getYahooClient();
      const charts = (c ?? {}) as Record<string, unknown>;
      const real = { quote: client.quote, chart: client.chart };
      Object.assign(client, {
        quote: () => Promise.resolve(a),
        chart: (symbol: string) =>
          Object.hasOwn(charts, symbol)
            ? Promise.resolve(charts[symbol])
            : Promise.reject(new Error("no chart")),
      });
      try {
        return await PROVIDERS.yahoo(b as string[]);
      } finally {
        Object.assign(client, real);
      }
    }
    case "kinesisLive":
      return await withFetchAnswer(b, () =>
        PROVIDERS.kinesis([a as InvestmentRow]),
      );
    default:
      throw new Error(`unknown price operation: ${String(name)}`);
  }
}

type LedgerRows = [number, string, string][];

/** A temporary directory for one call, removed afterwards. */
async function withScratch<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vision-parity-"));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Writes the migration files of a call; `null` stands for a missing directory. */
function migrationDirectory(
  root: string,
  files: Record<string, string> | null,
): string {
  const directory = path.join(root, "migrations");
  if (files === null) return directory;
  fs.mkdirSync(directory);
  for (const [name, text] of Object.entries(files))
    fs.writeFileSync(path.join(directory, name), text);
  return directory;
}

/** An in-memory database with the given ledger (`null`: no ledger table) and tables. */
function ledgerDatabase(
  ledger: LedgerRows | null,
  hasObjects: boolean,
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  if (hasObjects) db.exec("CREATE TABLE parity_existing (x)");
  if (ledger !== null) {
    db.exec(
      `CREATE TABLE ${LEDGER_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`,
    );
    const insert = db.prepare(
      `INSERT INTO ${LEDGER_TABLE} VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    for (const row of ledger) insert.run(...row);
  }
  return db;
}

/** Runs `run` with `new Date()` answering one instant. */
function atInstant<T>(epochMs: number, run: () => T): T {
  const RealDate = Date;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args: unknown[]) =>
      Reflect.construct(target, args.length === 0 ? [epochMs] : args) as Date,
  });
  try {
    return run();
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * One call of the migration runner's rules (`database/migrate.ts`) or of the boolean input
 * of `sqlite/values.ts`. A thrown error is recorded as `{ error }`, with the temporary
 * directory written as `<dir>`.
 */
export async function evaluateMigrations(op: unknown[]): Promise<unknown> {
  const [name, ...args] = op;
  return withScratch(async (root) => {
    const failure = (error: unknown): { error: string } => ({
      error: (error instanceof Error ? error.message : String(error))
        .split(root)
        .join("<dir>"),
    });
    try {
      switch (name) {
        case "load":
          return {
            migrations: loadMigrations(
              migrationDirectory(
                root,
                args[0] as Record<string, string> | null,
              ),
            ).map((m) => ({
              version: m.version,
              name: m.name,
              sha256: m.sha256,
              down: m.downSql ?? null,
            })),
          };
        case "plan": {
          const [files, ledger, hasObjects] = args as [
            Record<string, string>,
            LedgerRows | null,
            boolean,
          ];
          const db = ledgerDatabase(ledger, hasObjects);
          try {
            return {
              pending: planMigrations(
                db,
                loadMigrations(migrationDirectory(root, files)),
              ).map((m) => m.name),
            };
          } finally {
            db.close();
          }
        }
        case "run": {
          const [files, ledger, hasObjects, target, skipBackup, onDisk] =
            args as [
              Record<string, string>,
              LedgerRows | null,
              boolean,
              number | null,
              boolean,
              boolean,
            ];
          const db = ledgerDatabase(ledger, hasObjects);
          try {
            const result = migrateConnection(
              db,
              onDisk ? path.join(root, "vision.sqlite3") : ":memory:",
              {
                dir: migrationDirectory(root, files),
                skipBackup,
                backupDir: path.join(root, "copies"),
                ...(target === null ? {} : { targetVersion: target }),
              },
            );
            return {
              revision: result.revision ?? null,
              applied: result.applied,
              backup: result.backupFile !== undefined,
            };
          } finally {
            db.close();
          }
        }
        case "revert": {
          const [files, applied] = args as [Record<string, string>, number];
          const dir = migrationDirectory(root, files);
          const file = path.join(root, "vision.sqlite3");
          await runMigrations(file, {
            dir,
            skipBackup: true,
            targetVersion: applied,
          });
          return {
            revision: (await revertLatestMigration(file, { dir })) ?? null,
          };
        }
        case "violations": {
          // The rows SQLite reports for the SQL, and the refusal of a run that leaves them.
          const sql = String(args[0]);
          const probe = new DatabaseSync(":memory:", {
            enableForeignKeyConstraints: false,
          });
          const db = new DatabaseSync(":memory:");
          try {
            probe.exec(sql);
            const rows = (
              probe.prepare("PRAGMA foreign_key_check").all() as {
                table: string;
                rowid: number | null;
                parent: string;
              }[]
            ).map((r) => [r.table, r.rowid, r.parent]);
            let message: string | null = null;
            try {
              migrateConnection(db, ":memory:", {
                dir: migrationDirectory(root, { "0001_parity.sql": sql }),
              });
            } catch (error) {
              message = failure(error).error;
            }
            return { rows, message };
          } finally {
            probe.close();
            db.close();
          }
        }
        case "backup": {
          const [relative, from, to, epochMs] = args as [
            string,
            number,
            number,
            number,
          ];
          const db = new DatabaseSync(":memory:");
          try {
            const target = atInstant(epochMs, () =>
              writePreMigrationBackup(db, path.join(root, relative), from, to),
            );
            return {
              name: path.basename(target),
              directory: path.dirname(target).split(root).join("<dir>"),
            };
          } finally {
            db.close();
          }
        }
        case "prune": {
          const copies = args[0] as [string, number][];
          const directory = path.join(root, "copies");
          fs.mkdirSync(directory);
          for (const [file, modifiedMs] of copies) {
            fs.writeFileSync(path.join(directory, file), "");
            fs.utimesSync(
              path.join(directory, file),
              modifiedMs / 1000,
              modifiedMs / 1000,
            );
          }
          const db = new DatabaseSync(":memory:");
          try {
            const written = path.basename(
              writePreMigrationBackup(
                db,
                path.join(root, "vision.sqlite3"),
                1,
                2,
                directory,
              ),
            );
            return fs
              .readdirSync(directory)
              .filter((file) => file !== written)
              .sort();
          } finally {
            db.close();
          }
        }
        case "fingerprint": {
          const rows = (
            args[0] as [string, string, string, string | null][]
          ).map(([type, objectName, table, sql]) => ({
            type,
            name: objectName,
            tbl_name: table,
            sql,
          }));
          // The function reads four columns of every row; the rows stand in for the query.
          const db = {
            prepare: () => ({ all: () => rows }),
          } as unknown as DatabaseSync;
          return schemaFingerprint(db);
        }
        case "boolean":
          return { value: booleanInput(args[0]) };
        default:
          throw new Error(`unknown migration operation: ${String(name)}`);
      }
    } catch (error) {
      return failure(error);
    }
  });
}

async function rerecordAsync(
  file: string,
  line: (recorded: string) => Promise<unknown>,
  check: boolean,
): Promise<void> {
  const recorded = fs.readFileSync(file, "utf8");
  let next = "";
  for (const text of recorded.split("\n")) {
    if (text !== "") next += `${JSON.stringify(await line(text))}\n`;
  }
  if (!check) fs.writeFileSync(file, next);
  else if (next !== recorded) {
    console.error(`${file} is stale: run \`bun run native:parity-plans\``);
    process.exitCode = 1;
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
  await rerecordAsync(
    FORECAST,
    async (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: await evaluateForecast(op) };
    },
    check,
  );
  await rerecordAsync(
    BANK_IMPORT,
    async (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: await evaluateBankImport(op) };
    },
    check,
  );
  await rerecordAsync(
    PORTFOLIO_IMPORT,
    async (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: await evaluatePortfolioImport(op) };
    },
    check,
  );
  await rerecordAsync(
    PRICES,
    async (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: await evaluatePrices(op) };
    },
    check,
  );
  await rerecordAsync(
    MIGRATIONS,
    async (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: await evaluateMigrations(op) };
    },
    check,
  );
  await rerecordAsync(
    WORKBOOK,
    async (text) => {
      const { op } = JSON.parse(text) as { op: unknown[] };
      return { op, r: await evaluateWorkbook(op) };
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
