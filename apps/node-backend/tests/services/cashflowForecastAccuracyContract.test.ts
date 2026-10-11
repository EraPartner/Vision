/**
 * The ensemble weights come from the forecast-accuracy repository. When that
 * read fails because the DB is unavailable the forecast degrades to equal
 * weights; when it fails because a stored row violates its row contract the
 * fault must surface instead of being hidden behind the equal-weight fallback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RowContractError } from "../../src/database/rowContracts.ts";
import { addDaysYmd, todayAppDateString } from "../../src/lib/timezone.ts";
import type { AggregationEnvelope } from "../../src/services/calculations/aggregation/_envelope.ts";
import { computeCashflowForecastRolling } from "../../src/services/calculations/forecast/index.ts";
import type {
  DailyNetPoint,
  MethodResult,
} from "../../src/services/calculations/forecast/index.ts";

const isoOffsetFromToday = (offsetDays: number) =>
  addDaysYmd(todayAppDateString(), offsetDays);

const buildHistory = (days: number) => {
  const out: DailyNetPoint[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < days; i++) {
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      net: 5 * Math.sin((2 * Math.PI * i) / 7) + 1,
    });
  }
  return out;
};

vi.mock("../../src/repositories/infoRepository.ts", () => ({
  infoRepository: {
    getIncludeTransfers: vi.fn(async () => false),
    getCashflowForecastDataRolling: vi.fn(async (historyMonths: number) => ({
      history: buildHistory(400),
      currentActual: Array.from({ length: 31 }, (_, i) => ({
        date: isoOffsetFromToday(-30 + i),
        net: 10,
      })),
      scheduledActual: [],
      plannedCurrent: [],
      historyMonths,
    })),
    getCashflowForecastData: vi.fn(),
    getCashflowForecastDataByCategory: vi.fn(),
  },
}));

const getLatestAccuracyByMethod = vi.hoisted(() => vi.fn());
vi.mock(
  "../../src/services/calculations/forecast/accuracyStore.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/services/calculations/forecast/accuracyStore.ts")
    >()),
    getLatestAccuracyByMethod,
  }),
);

// Non-default MC paths skip the rolling MC cache, so no other DB read runs.
const run = () =>
  computeCashflowForecastRolling({
    daysBack: 30,
    daysForward: 30,
    mcPaths: 50,
    userId: "u1",
  }) as Promise<AggregationEnvelope<{ methods: MethodResult[] }>>;

describe("forecast ensemble accuracy read", () => {
  beforeEach(() => {
    getLatestAccuracyByMethod.mockReset();
  });

  it("surfaces a row-contract violation from the accuracy repository", async () => {
    getLatestAccuracyByMethod.mockRejectedValue(
      new RowContractError("Row contract violated (accuracy)", [
        "mae: expected number, received string",
      ]),
    );
    await expect(run()).rejects.toBeInstanceOf(RowContractError);
  });

  it("keeps the equal-weight ensemble when the accuracy read fails otherwise", async () => {
    getLatestAccuracyByMethod.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    const env = await run();
    const ensemble = env.data.methods.find((m) => m.id === "ensemble_imse");
    expect(ensemble).toBeDefined();
    expect(ensemble!.error).toBeNull();
    expect(ensemble!.daily).toHaveLength(30);
    expect(getLatestAccuracyByMethod).toHaveBeenCalledWith({ userId: "u1" });
  });
});
