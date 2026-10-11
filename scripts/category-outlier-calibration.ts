#!/usr/bin/env bun

import {
  __computeOutliers as computeOutliers,
  type CategoryOutlierExpenseRow,
  type CategoryOutlierFinding,
} from "../apps/node-backend/src/services/categoryOutlierService.ts";

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null;

const baseUrl = process.env.VISION_CALIBRATION_API_BASE_URL;
if (!baseUrl) {
  throw new Error(
    "Set VISION_CALIBRATION_API_BASE_URL to the running local Vision URL",
  );
}

const parsedBaseUrl = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "::1"].includes(parsedBaseUrl.hostname)) {
  throw new Error(
    "Category-outlier calibration accepts only a loopback Vision URL",
  );
}

const PAGE_SIZE = 5000;

async function fetchTransactions(): Promise<unknown[]> {
  const rows: unknown[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const url = new URL("/api/transactions", parsedBaseUrl);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Vision transaction request failed with HTTP ${response.status}`,
      );
    }
    const envelope: unknown = await response.json();
    const page = isRecord(envelope) ? envelope.data : undefined;
    if (!isRecord(page) || !Array.isArray(page.items)) {
      throw new Error("Vision transaction response has an unexpected shape");
    }
    total = Number(page.total);
    rows.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0) break;
  }
  return rows;
}

function monthStart(monthKey: string): Date {
  const [year = Number.NaN, month = Number.NaN] = monthKey
    .split("-")
    .map(Number);
  return new Date(year, month - 1, 1, 12);
}

function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function findingKey(
  finding: CategoryOutlierFinding,
  targetMonth: string,
): string {
  return `${targetMonth}:${finding.comparisonEndDay}:${finding.categoryId}`;
}

function categorySignalKey(
  finding: CategoryOutlierFinding,
  targetMonth: string,
): string {
  return `${targetMonth}:${finding.categoryId}`;
}

/** A categorized expense as the outlier service reads it, labels dropped. */
function toExpenseRow(transaction: Row): CategoryOutlierExpenseRow {
  const date = transaction.transaction_date ?? transaction.date;
  const { amount, category_id: categoryId } = transaction;
  if (
    !(typeof date === "string" || date instanceof Date) ||
    !(typeof amount === "string" || typeof amount === "number") ||
    typeof categoryId !== "number"
  ) {
    throw new Error("Vision transaction response has an unexpected shape");
  }
  return {
    date,
    amount,
    category_id: categoryId,
    // Never retain or print category labels, recipients, account names, memos,
    // comments, or any other identifying transaction field.
    category_name: null,
  };
}

const sourceTransactions = await fetchTransactions();
const rows = sourceTransactions
  .filter(
    (transaction): transaction is Row =>
      isRecord(transaction) &&
      transaction.is_active === true &&
      transaction.category_id != null &&
      Number(transaction.amount) < 0,
  )
  .map(toExpenseRow);

const sourceMonths = [
  ...new Set(rows.map((row) => String(row.date).slice(0, 7))),
].sort();
const firstMonth = sourceMonths[0];
const lastMonth = sourceMonths[sourceMonths.length - 1];
if (
  sourceMonths.length < 7 ||
  firstMonth === undefined ||
  lastMonth === undefined
) {
  throw new Error("At least seven months of categorized expenses are required");
}

const firstEvaluation = shiftMonth(monthStart(firstMonth), 6);
const lastEvaluation = monthStart(lastMonth);
const evaluationMonths: string[] = [];
for (
  let cursor = firstEvaluation;
  cursor <= lastEvaluation;
  cursor = shiftMonth(cursor, 1)
) {
  evaluationMonths.push(monthKey(cursor));
}

const policyNames = ["sensitive", "current", "conservative"] as const;
type PolicyName = (typeof policyNames)[number];
const policies: Record<
  PolicyName,
  { outlierZThreshold: number; flatBaselineOverspendFloorEur: number }
> = {
  sensitive: { outlierZThreshold: 3, flatBaselineOverspendFloorEur: 25 },
  current: { outlierZThreshold: 3.5, flatBaselineOverspendFloorEur: 50 },
  conservative: { outlierZThreshold: 4, flatBaselineOverspendFloorEur: 75 },
};
const policyFindings: Record<PolicyName, Set<string>> = {
  sensitive: new Set(),
  current: new Set(),
  conservative: new Set(),
};
const currentByDay = new Map<string, Set<string>>();

for (const evaluationMonth of evaluationMonths) {
  const start = monthStart(evaluationMonth);
  for (const day of [8, 15, 28]) {
    const today = new Date(start.getFullYear(), start.getMonth(), day, 12);
    for (const name of policyNames) {
      const policy = policies[name];
      const findings = computeOutliers(rows, today, policy);
      const keys = findings.map((finding) =>
        findingKey(finding, evaluationMonth),
      );
      for (const key of keys) policyFindings[name].add(key);
      if (name === "current") {
        currentByDay.set(
          `${evaluationMonth}:${day}`,
          new Set(
            findings.map((finding) =>
              categorySignalKey(finding, evaluationMonth),
            ),
          ),
        );
      }
    }
  }
}

const sensitiveOnly = [...policyFindings.sensitive].filter(
  (key) => !policyFindings.current.has(key),
).length;
const currentOnlyVsConservative = [...policyFindings.current].filter(
  (key) => !policyFindings.conservative.has(key),
).length;
let earlyOnly = 0;
for (const evaluationMonth of evaluationMonths) {
  const early = currentByDay.get(`${evaluationMonth}:8`) ?? new Set();
  const monthEnd = currentByDay.get(`${evaluationMonth}:28`) ?? new Set();
  earlyOnly += [...early].filter((key) => !monthEnd.has(key)).length;
}

const categoryCount = new Set(rows.map((row) => row.category_id)).size;
console.log(
  JSON.stringify(
    {
      privacy:
        "aggregate-only; labels, recipients, accounts, memos, and comments were discarded",
      categorizedExpensesAnalyzed: rows.length,
      categoryHistories: categoryCount,
      sourceMonthCount: sourceMonths.length,
      evaluationMonthCount: evaluationMonths.length,
      evaluationSnapshots: evaluationMonths.length * 3,
      alerts: Object.fromEntries(
        Object.entries(policyFindings).map(([name, findings]) => [
          name,
          findings.size,
        ]),
      ),
      tradeoffProxies: {
        sensitiveOnlyPotentialMisses: sensitiveOnly,
        currentOnlyVsConservativePotentialNoise: currentOnlyVsConservative,
        day8SignalsAbsentByDay28: earlyOnly,
      },
    },
    null,
    2,
  ),
);
