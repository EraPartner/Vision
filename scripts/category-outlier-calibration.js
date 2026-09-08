#!/usr/bin/env node

import { __computeOutliers as computeOutliers } from "../apps/node-backend/src/services/categoryOutlierService.js";

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

async function fetchTransactions() {
  const rows = [];
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
    const envelope = await response.json();
    const page = envelope?.data;
    if (!page || !Array.isArray(page.items)) {
      throw new Error("Vision transaction response has an unexpected shape");
    }
    total = Number(page.total);
    rows.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0) break;
  }
  return rows;
}

function monthStart(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1, 12);
}

function shiftMonth(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function findingKey(finding, targetMonth) {
  return `${targetMonth}:${finding.comparisonEndDay}:${finding.categoryId}`;
}

function categorySignalKey(finding, targetMonth) {
  return `${targetMonth}:${finding.categoryId}`;
}

const sourceTransactions = await fetchTransactions();
const rows = sourceTransactions
  .filter(
    (transaction) =>
      transaction.is_active === true &&
      transaction.category_id != null &&
      Number(transaction.amount) < 0,
  )
  .map((transaction) => ({
    date: transaction.transaction_date ?? transaction.date,
    amount: transaction.amount,
    category_id: transaction.category_id,
    // Never retain or print category labels, recipients, account names, memos,
    // comments, or any other identifying transaction field.
    category_name: null,
  }));

const sourceMonths = [
  ...new Set(rows.map((row) => String(row.date).slice(0, 7))),
].sort();
if (sourceMonths.length < 7) {
  throw new Error("At least seven months of categorized expenses are required");
}

const firstEvaluation = shiftMonth(monthStart(sourceMonths[0]), 6);
const lastEvaluation = monthStart(sourceMonths[sourceMonths.length - 1]);
const evaluationMonths = [];
for (
  let cursor = firstEvaluation;
  cursor <= lastEvaluation;
  cursor = shiftMonth(cursor, 1)
) {
  evaluationMonths.push(monthKey(cursor));
}

const policies = {
  sensitive: { outlierZThreshold: 3, flatBaselineOverspendFloorEur: 25 },
  current: { outlierZThreshold: 3.5, flatBaselineOverspendFloorEur: 50 },
  conservative: { outlierZThreshold: 4, flatBaselineOverspendFloorEur: 75 },
};
const policyFindings = Object.fromEntries(
  Object.keys(policies).map((name) => [name, new Set()]),
);
const currentByDay = new Map();

for (const evaluationMonth of evaluationMonths) {
  const start = monthStart(evaluationMonth);
  for (const day of [8, 15, 28]) {
    const today = new Date(start.getFullYear(), start.getMonth(), day, 12);
    for (const [name, policy] of Object.entries(policies)) {
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
