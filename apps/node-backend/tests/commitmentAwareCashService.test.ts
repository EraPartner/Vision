import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/plannedTransactionRepository.ts", () => ({
  default: { getForCommitmentProjection: vi.fn() },
}));
vi.mock("../src/services/crossWorkspaceDataService.ts", () => ({
  assembleRebalanceInputs: vi.fn(),
}));
vi.mock("../src/services/currency/currencyConversionService.ts", () => ({
  listLatestStoredRates: vi.fn().mockResolvedValue({
    rows: [
      { currency_code: "USD", rate_to_eur: "0.5", rate_date: "2026-09-18" },
    ],
  }),
  convertWithRates: vi.fn((amount, from, to) =>
    from === "USD" && to !== "USD" ? amount / 2 : amount,
  ),
}));

import rawPlannedTransactionRepository from "../src/repositories/plannedTransactionRepository.ts";
import type { PlannedCommitmentRow } from "../src/repositories/plannedTransactionRepository.ts";
import { assembleRebalanceInputs as rawAssembleRebalanceInputs } from "../src/services/crossWorkspaceDataService.ts";
import {
  convertWithRates as rawConvertWithRates,
  listLatestStoredRates as rawListLatestStoredRates,
} from "../src/services/currency/currencyConversionService.ts";
import { computeCommitmentAwareCash } from "../src/services/commitmentAwareCashService.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { loose, partial } from "./helpers/partial.ts";

const plannedTransactionRepository = vi.mocked(rawPlannedTransactionRepository);
const assembleRebalanceInputs = vi.mocked(rawAssembleRebalanceInputs);
const convertWithRates = vi.mocked(rawConvertWithRates);
const listLatestStoredRates = vi.mocked(rawListLatestStoredRates);
type RebalanceInputs = Awaited<ReturnType<typeof rawAssembleRebalanceInputs>>;
/** Fixture rows carry wire-shaped string dates; the service normalizes both. */
const commitmentRows = (rows: unknown[]) => loose<PlannedCommitmentRow[]>(rows);

beforeEach(() => {
  vi.clearAllMocks();
  convertWithRates.mockImplementation((amount, from, to) =>
    from === "USD" && to !== "USD" ? amount / 2 : amount,
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  listLatestStoredRates.mockResolvedValue(
    partial<PgQueryResult>({
      rows: [
        { currency_code: "USD", rate_to_eur: "0.5", rate_date: "2026-09-18" },
      ],
    }),
  );
  assembleRebalanceInputs.mockResolvedValue(
    partial<RebalanceInputs>({
      availableCash: 1000,
      cashCurrencies: ["EUR"],
    }),
  );
});

describe("computeCommitmentAwareCash", () => {
  it("counts pending planned and bounded recurring bills once within 90 days", async () => {
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 1,
          planned_date: "2026-09-25",
          amount: "-100",
          currency: "EUR",
          is_recurring: false,
          execution_count: 0,
        },
        {
          id: 2,
          planned_date: "2026-10-01",
          amount: "-200",
          currency: "USD",
          is_recurring: true,
          recurrence_pattern: "monthly",
          max_occurrences: 3,
          execution_count: 1,
        },
        {
          id: 4,
          planned_date: "2026-09-21",
          amount: "5000",
          currency: "EUR",
          is_recurring: false,
          execution_count: 0,
        },
      ]),
    );
    convertWithRates.mockImplementation((amount, from) =>
      from === "USD" ? amount / 2 : amount,
    );

    try {
      const result = await computeCommitmentAwareCash({ reserveFloor: 250 });
      expect(
        plannedTransactionRepository.getForCommitmentProjection,
      ).toHaveBeenCalledWith("2026-12-18");
      expect(result).toMatchObject({
        currentCash: 1000,
        reserveFloor: 250,
        horizonDays: 90,
        occurrenceCount: 3,
        minimumProjectedBalance: 700,
        candidateCashCap: 450,
      });
      expect(convertWithRates).toHaveBeenCalledTimes(3);
      expect(assembleRebalanceInputs).toHaveBeenCalledWith({
        currency: "EUR",
        rates: { EUR: 1, USD: 0.5 },
      });
      expect(convertWithRates).toHaveBeenCalledWith(-200, "USD", "EUR", {
        EUR: 1,
        USD: 0.5,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a recurrence at its end date", async () => {
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 3,
          planned_date: "2026-09-20",
          amount: "-80",
          currency: "EUR",
          is_recurring: true,
          recurrence_pattern: "weekly",
          recurrence_end_date: "2026-09-27",
          execution_count: 0,
        },
      ]),
    );
    try {
      const result = await computeCommitmentAwareCash();
      expect(result.occurrenceCount).toBe(2);
      expect(result.minimumProjectedBalance).toBe(840);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when an old daily recurrence exceeds the expansion limit", async () => {
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 5,
          planned_date: "2023-01-01",
          amount: "-1",
          currency: "EUR",
          is_recurring: true,
          recurrence_pattern: "daily",
          execution_count: 0,
        },
      ]),
    );
    try {
      await expect(computeCommitmentAwareCash()).rejects.toThrow(
        /recurring item exceeds expansion limit/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a 500th occurrence at the horizon without assuming a 501st bill", async () => {
    const end = new Date("2026-12-18T00:00:00Z");
    end.setUTCDate(end.getUTCDate() - 499);
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 7,
          planned_date: end.toISOString().slice(0, 10),
          amount: "-1",
          currency: "EUR",
          is_recurring: true,
          recurrence_pattern: "daily",
          execution_count: 0,
        },
      ]),
    );
    try {
      const result = await computeCommitmentAwareCash();
      expect(result.occurrenceCount).toBe(500);
      expect(result.candidateCashCap).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for a bill with no supported exchange rate", async () => {
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 6,
          planned_date: "2026-09-20",
          amount: "-100",
          currency: "XYZ",
          is_recurring: false,
          execution_count: 0,
        },
      ]),
    );
    try {
      await expect(computeCommitmentAwareCash()).rejects.toThrow(
        /no exchange rate for XYZ/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for a foreign-currency bill with stale stored rates", async () => {
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 8,
          planned_date: "2026-09-20",
          amount: "-100",
          currency: "USD",
          is_recurring: false,
          execution_count: 0,
        },
      ]),
    );
    listLatestStoredRates.mockResolvedValue(
      partial<PgQueryResult>({
        rows: [
          { currency_code: "USD", rate_to_eur: "0.5", rate_date: "2026-08-01" },
        ],
      }),
    );
    try {
      await expect(computeCommitmentAwareCash()).rejects.toThrow(
        /exchange rate for USD is stale/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs no exchange rate when all cash and bills share the target currency", async () => {
    listLatestStoredRates.mockResolvedValue(
      partial<PgQueryResult>({ rows: [] }),
    );
    assembleRebalanceInputs.mockResolvedValue(
      partial<RebalanceInputs>({
        availableCash: 1000,
        cashCurrencies: ["USD"],
      }),
    );
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 9,
          planned_date: "2026-09-20",
          amount: "-100",
          currency: "USD",
          is_recurring: false,
          execution_count: 0,
        },
      ]),
    );
    try {
      const result = await computeCommitmentAwareCash({ currency: "USD" });
      expect(result.candidateCashCap).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores missing rates for bills with no remaining occurrence", async () => {
    listLatestStoredRates.mockResolvedValue(
      partial<PgQueryResult>({ rows: [] }),
    );
    plannedTransactionRepository.getForCommitmentProjection.mockResolvedValue(
      commitmentRows([
        {
          id: 10,
          planned_date: "2026-09-20",
          amount: "-100",
          currency: "XYZ",
          is_recurring: true,
          recurrence_pattern: "monthly",
          max_occurrences: 1,
          execution_count: 1,
        },
      ]),
    );
    try {
      const result = await computeCommitmentAwareCash();
      expect(result.occurrenceCount).toBe(0);
      expect(result.candidateCashCap).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
