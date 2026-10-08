/**
 * Transaction-derived Belgian deduction candidates for a calendar year.
 *
 * Single source of truth for the classify-and-aggregate step shared by the
 * getDeductibles AI-chat tool and GET /api/info/deduction-candidates (the Tax
 * Overview review card). It scans the year's active outflow transactions,
 * classifies each user category via the explicit name-based classifier
 * (deductionClassifier.js — precision over recall, unrecognized categories are
 * excluded) and rolls the matches up per deduction type WITH the contributing
 * categories nested under each type, which the review UI needs to show where a
 * candidate total comes from.
 *
 * Pure with respect to time: `year` is always provided by the caller (routes
 * default it to the current calendar year; the AI tool requires it), so this
 * module never reads the clock.
 */

import { parseCategoryName } from "@vision/shared-utils";
import { transactionRepository } from "../../repositories/transactionRepository.ts";
import { listCategoryNodes } from "../categoryService.ts";
import { toDecimal, roundToCents } from "../../lib/money.ts";
import { classifyDeduction } from "./deductionClassifier.ts";

/** A decimal.js money value, as produced by the shared `toDecimal` helper. */
export type Money = ReturnType<typeof toDecimal>;

/** One category contributing to a deduction-type candidate total. */
export interface DeductionCandidateCategory {
  category: string;
  total: number;
  count: number;
}

/** A per-deduction-type candidate total with its contributing categories. */
export interface DeductionCandidateGroup {
  deductionType: string;
  total: number;
  categoryCount: number;
  categories: DeductionCandidateCategory[];
}

export interface DeductionCandidates {
  year: number;
  from: string;
  to: string;
  currency: "EUR";
  /** sorted by total desc; nested categories sorted by total desc */
  byDeductionType: DeductionCandidateGroup[];
}

/**
 * Compute per-deduction-type candidate totals for one calendar year.
 *
 * @param params - validated calendar year (the caller is responsible for
 *   validation/defaulting).
 * @returns groups sorted by total desc; nested categories sorted by total desc.
 */
export async function computeDeductionCandidates({
  year,
}: {
  year: number;
}): Promise<DeductionCandidates> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const rows = await transactionRepository.getAll({
    startDate: from,
    endDate: to,
    limit: 100_000,
    offset: 0,
    active: true,
  });
  const hasCategoryIds = rows.some(
    (row) =>
      Number.isInteger(Number(row.effective_category_id)) &&
      row.effective_category_id != null,
  );
  const pathsById: Map<number, string[]> = hasCategoryIds
    ? new Map((await listCategoryNodes()).map((node) => [node.id, node.path]))
    : new Map();

  // Pass 1: group outflows by raw category name, classifying each category.
  const byCategory = new Map<
    string,
    { category: string; deductionType: string; total: Money; count: number }
  >();
  for (const row of rows) {
    const amount = toDecimal(row.amount ?? 0);
    if (amount.gte(0)) continue; // outflows only

    if (!row.category_name) continue;
    const path = pathsById.get(Number(row.effective_category_id));
    // Preserve the old two-part classifier for historical rows. For new deep
    // paths, use ordered segments rather than splitting a display delimiter.
    const { general, detail } = path
      ? { general: path[0] ?? "", detail: path.slice(1).join(" ") }
      : parseCategoryName(row.category_name);
    const deductionType = classifyDeduction(general, detail);
    if (!deductionType) continue; // not a recognized deductible

    const key = row.category_name;
    const entry = byCategory.get(key) || {
      category: key,
      deductionType,
      total: toDecimal(0),
      count: 0,
    };
    entry.total = entry.total.plus(amount.abs());
    entry.count += 1;
    byCategory.set(key, entry);
  }

  // Pass 2: roll categories up per deduction type, keeping the contributors
  // nested (totals stay Decimal until the final rounding).
  const typeAgg = new Map<
    string,
    { total: Money; categories: DeductionCandidateCategory[] }
  >();
  for (const entry of byCategory.values()) {
    const agg = typeAgg.get(entry.deductionType) || {
      total: toDecimal(0),
      categories: [],
    };
    agg.total = agg.total.plus(entry.total);
    agg.categories.push({
      category: entry.category,
      total: roundToCents(entry.total).toNumber(),
      count: entry.count,
    });
    typeAgg.set(entry.deductionType, agg);
  }

  const byDeductionType = Array.from(typeAgg.entries())
    .map(([deductionType, agg]) => ({
      deductionType,
      total: roundToCents(agg.total).toNumber(),
      categoryCount: agg.categories.length,
      categories: agg.categories.sort((a, b) => b.total - a.total),
    }))
    .sort((a, b) => b.total - a.total);

  return { year, from, to, currency: "EUR", byDeductionType };
}
