import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asAccountId,
} from "@vision/types/brands";

vi.mock("../src/repositories/transactionRepository.ts", () => ({
  transactionRepository: {
    getAll: vi.fn(),
  },
}));
vi.mock("../src/services/categoryService.ts", () => ({
  listCategoryNodes: vi.fn(),
}));
vi.mock("../src/repositories/accountRepository.ts", () => ({
  default: { listOwners: vi.fn() },
}));

import { transactionRepository as rawTransactionRepository } from "../src/repositories/transactionRepository.ts";
import type { EnrichedTransactionRow } from "../src/repositories/transactionRepository.ts";
import type { CategoryNode } from "../src/repositories/categoryHierarchyRepository.ts";
import { listCategoryNodes as rawListCategoryNodes } from "../src/services/categoryService.ts";
import rawAccountRepository from "../src/repositories/accountRepository.ts";
import { computeDeductionCandidates } from "../src/services/tax/deductionCandidatesService.ts";
import { partial } from "./helpers/partial.ts";
import { loose } from "./helpers/partial.ts";
import type { Mock } from "vitest";

/** The given methods of `T`, typed as the spies a `vi.mock` factory installed. */
type Spies<T, K extends keyof T> = Record<
  K,
  Mock<Extract<T[K], (...args: never[]) => unknown>>
>;

const transactionRepositoryMock = loose<Spies<typeof rawTransactionRepository, "getAll">>(rawTransactionRepository);
const accountRepositoryMock = loose<Spies<typeof rawAccountRepository, "listOwners">>(rawAccountRepository);

const transactionRepository = vi.mocked(rawTransactionRepository);
const listCategoryNodes = vi.mocked(rawListCategoryNodes);
const accountRepository = vi.mocked(rawAccountRepository);
const mine = (total: number) => ({ me: total, partner: 0, joint: 0 });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("computeDeductionCandidates", () => {
  it("does not roll ambiguous category spending into annual deduction totals", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        { amount: "-1000", category_name: "RETIREMENT:HOME" },
        { amount: "-500", category_name: "SAVINGS:RETIREMENT" },
        { amount: "-200", category_name: "INSURANCE:GROUP TRAVEL" },
        { amount: "-300", category_name: "SCHENKING:KINDEREN" },
        { amount: "-40", category_name: "GROEPSVERZEKERING:PENSIOEN" },
        { amount: "-20", category_name: "UNION:DUES" },
      ]),
    );
    const result = await computeDeductionCandidates({ year: 2025 });
    expect(
      result.byDeductionType.map(({ deductionType, total }) => ({
        deductionType,
        total,
      })),
    ).toEqual([
      { deductionType: "groupInsurance", total: 40 },
      { deductionType: "unionDues", total: 20 },
    ]);
  });
  it("queries the year window for active transactions", async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);

    await computeDeductionCandidates({ year: 2025 });

    expect(transactionRepositoryMock.getAll).toHaveBeenCalledWith({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      limit: 100_000,
      offset: 0,
      active: true,
    });
  });

  it("classifies outflows, nests categories under types and rolls up totals", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        { amount: "-90", category_name: "PENSION:SAVINGS" },
        { amount: "-30", category_name: "PENSION:SAVINGS" },
        { amount: "-200", category_name: "GIVING:DONATION" },
        { amount: "-75", category_name: "INSURANCE:LIFE" },
        { amount: "-25", category_name: "PENSIOENSPAREN" }, // NL, same type other category
      ]),
    );

    const result = await computeDeductionCandidates({ year: 2025 });

    expect(result).toEqual({
      year: 2025,
      from: "2025-01-01",
      to: "2025-12-31",
      currency: "EUR",
      byDeductionType: [
        {
          deductionType: "charitableDonations",
          total: 200,
          byOwner: mine(200),
          partnerShares: { A: 200, B: 0 },
          categoryCount: 1,
          categories: [{ category: "GIVING:DONATION", total: 200, count: 1 }],
        },
        {
          deductionType: "pensionSavings",
          total: 145,
          byOwner: mine(145),
          partnerShares: { A: 145, B: 0 },
          categoryCount: 2,
          // Nested contributors sorted by total desc.
          categories: [
            { category: "PENSION:SAVINGS", total: 120, count: 2 },
            { category: "PENSIOENSPAREN", total: 25, count: 1 },
          ],
        },
        {
          deductionType: "lifeInsurance",
          total: 75,
          byOwner: mine(75),
          partnerShares: { A: 75, B: 0 },
          categoryCount: 1,
          categories: [{ category: "INSURANCE:LIFE", total: 75, count: 1 }],
        },
      ],
    });
  });

  it("excludes non-deductible categories, inflows and unlabeled rows", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        { amount: "-40", category_name: "GIVING:DONATION" },
        { amount: "-500", category_name: "INSURANCE:CAR" }, // not deductible, skip
        { amount: "-100", category_name: "health:medical" }, // not deductible, skip
        { amount: "-40", category_name: "GIFTS:BIRTHDAY" }, // present, not donation, skip
        { amount: "100", category_name: "GIVING:DONATION" }, // inflow, skip
        { amount: "-60", category_name: null }, // no label, skip
      ]),
    );

    const result = await computeDeductionCandidates({ year: 2025 });

    expect(result.byDeductionType).toEqual([
      {
        deductionType: "charitableDonations",
        total: 40,
        byOwner: mine(40),
        partnerShares: { A: 40, B: 0 },
        categoryCount: 1,
        categories: [{ category: "GIVING:DONATION", total: 40, count: 1 }],
      },
    ]);
  });

  it("classifies an assigned deep node from ordered path segments", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        {
          amount: "-75",
          effective_category_id: 44,
          category_name: "OLD:ALIAS",
        },
      ]),
    );
    listCategoryNodes.mockResolvedValueOnce(
      partial<CategoryNode[]>([
        { id: 44, path: ["INSURANCE", "POLICIES", "LIFE"] },
      ]),
    );

    const result = await computeDeductionCandidates({ year: 2025 });

    expect(result.byDeductionType).toEqual([
      {
        deductionType: "lifeInsurance",
        total: 75,
        byOwner: mine(75),
        partnerShares: { A: 75, B: 0 },
        categoryCount: 1,
        categories: [{ category: "OLD:ALIAS", total: 75, count: 1 }],
      },
    ]);
  });

  it("splits each total by the owner of the transaction's account", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        { amount: "-100", category_name: "PENSION:SAVINGS", account_id: 1 },
        { amount: "-80.10", category_name: "PENSION:SAVINGS", account_id: 2 },
        { amount: "-40.05", category_name: "PENSIOENSPAREN", account_id: 3 },
        { amount: "-10", category_name: "PENSION:SAVINGS", account_id: null },
        { amount: "-5", category_name: "PENSION:SAVINGS", account_id: 99 },
      ]),
    );
    accountRepository.listOwners.mockResolvedValueOnce([
      { id: asAccountId(1), owner: "me" },
      { id: asAccountId(2), owner: "partner" },
      { id: asAccountId(3), owner: "joint" },
    ]);

    const result = await computeDeductionCandidates({ year: 2025 });

    // No account and an unknown account both count as `me`.
    expect(result.byDeductionType).toEqual([
      expect.objectContaining({
        deductionType: "pensionSavings",
        total: 235.15,
        byOwner: { me: 115, partner: 80.1, joint: 40.05 },
        partnerShares: { A: 135.02, B: 100.13 },
      }),
    ]);
  });

  it("skips the account lookup when no row has an account", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        { amount: "-40", category_name: "GIVING:DONATION" },
      ]),
    );

    await computeDeductionCandidates({ year: 2025 });

    expect(accountRepositoryMock.listOwners).not.toHaveBeenCalled();
  });

  it("returns an empty byDeductionType when nothing classifies", async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      partial<EnrichedTransactionRow[]>([
        { amount: "-10", category_name: "food:coffee" },
        { amount: "-300", category_name: "INSURANCE:CAR" },
      ]),
    );

    const result = await computeDeductionCandidates({ year: 2024 });

    expect(result).toEqual({
      year: 2024,
      from: "2024-01-01",
      to: "2024-12-31",
      currency: "EUR",
      byDeductionType: [],
    });
  });
});
