import { describe, expect, it } from "vitest";
import { projectCommitmentAwareCash } from "../src/services/commitmentAwareCash.js";

describe("projectCommitmentAwareCash", () => {
  it("uses the lowest projected end-of-day balance and an editable reserve floor", () => {
    expect(
      projectCommitmentAwareCash({
        currentCash: 1000,
        reserveFloor: 250,
        today: "2026-09-19",
        horizonEnd: "2026-12-18",
        occurrences: [
          { date: "2026-09-25", amount: -400 },
          { date: "2026-10-01", amount: 600 },
          { date: "2026-10-10", amount: -300 },
        ],
      }),
    ).toMatchObject({
      minimumProjectedBalance: 600,
      minimumDate: "2026-09-25",
      candidateCashCap: 350,
    });
  });

  it("counts overdue obligations today and never offers more than current cash", () => {
    expect(
      projectCommitmentAwareCash({
        currentCash: 500,
        reserveFloor: 100,
        today: "2026-09-19",
        horizonEnd: "2026-12-18",
        occurrences: [
          { date: "2026-09-10", amount: -200 },
          { date: "2026-10-01", amount: 1000 },
        ],
      }),
    ).toMatchObject({
      minimumProjectedBalance: 300,
      minimumDate: "2026-09-19",
      candidateCashCap: 200,
    });
  });

  it("returns zero when the floor is breached and rejects invalid money", () => {
    const input = {
      currentCash: 100,
      reserveFloor: 100,
      today: "2026-09-19",
      horizonEnd: "2026-12-18",
      occurrences: [{ date: "2026-09-20", amount: -1 }],
    };
    expect(projectCommitmentAwareCash(input).candidateCashCap).toBe(0);
    expect(() =>
      projectCommitmentAwareCash({ ...input, reserveFloor: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      projectCommitmentAwareCash({
        ...input,
        occurrences: [{ date: "2026-09-20", amount: NaN }],
      }),
    ).toThrow(RangeError);
  });
});
