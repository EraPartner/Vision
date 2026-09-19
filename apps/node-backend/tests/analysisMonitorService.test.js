import { describe, expect, it, vi } from "vitest";
import {
  classifyMonitorRun,
  createAnalysisMonitor,
  evaluateThreshold,
  listMonitorObservations,
  readMonitorNotification,
} from "../src/services/analysisMonitorService.js";

const uuid = "00000000-0000-4000-8000-000000000001";

describe("analysis monitor safety", () => {
  it("compares exact decimal strings without floating point rounding", () => {
    expect(
      evaluateThreshold({
        previousValue: "9007199254740993.00",
        currentValue: "9007199254740993.01",
        operator: "above",
        threshold: "9007199254740993.00",
      }),
    ).toEqual({ met: true, crossed: true });
    expect(
      evaluateThreshold({
        previousValue: "0.1000",
        currentValue: "0.1",
        operator: "below",
        threshold: "0.10",
      }),
    ).toEqual({ met: false, crossed: false });
  });

  it("never treats partial, truncated, multi-row, or nonnumeric output as unchanged", () => {
    const complete = {
      status: "completed",
      definition_version: 2,
      result_json: {
        rows: [{ amount: "3.25" }],
        window: { kind: "page", offset: 0, returnedRows: 1, hasMore: false },
        formulaErrors: [],
      },
    };
    expect(classifyMonitorRun(complete, "amount")).toMatchObject({
      status: "valid",
      value: "3.25",
    });
    expect(
      classifyMonitorRun({ ...complete, status: "partial" }, "amount"),
    ).toMatchObject({
      status: "partial",
      reasonCode: "analysis-run-incomplete",
    });
    expect(
      classifyMonitorRun(
        {
          ...complete,
          result_json: {
            ...complete.result_json,
            window: { kind: "truncated" },
          },
        },
        "amount",
      ).status,
    ).toBe("partial");
    expect(
      classifyMonitorRun(
        {
          ...complete,
          result_json: {
            ...complete.result_json,
            rows: [{ amount: "1" }, { amount: "2" }],
          },
        },
        "amount",
      ).status,
    ).toBe("partial");
    expect(
      classifyMonitorRun(
        {
          ...complete,
          result_json: { ...complete.result_json, rows: [{ amount: "NaN" }] },
        },
        "amount",
      ).status,
    ).toBe("partial");
    expect(
      classifyMonitorRun(
        {
          ...complete,
          result_json: {
            ...complete.result_json,
            formulaErrors: [{ message: "bad" }],
          },
        },
        "amount",
      ).status,
    ).toBe("partial");
  });

  it("rejects invalid IDs and bodies before any database or network work", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected network call");
    });
    await expect(
      listMonitorObservations("not-a-uuid", {}),
    ).rejects.toMatchObject({ status: 400 });
    await expect(readMonitorNotification("not-a-uuid")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createAnalysisMonitor({
        kind: "dossier-evidence",
        title: "",
        dossierId: uuid,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createAnalysisMonitor({
        kind: "analysis-threshold",
        title: "x",
        savedAnalysisId: uuid,
        fieldId: "amount",
        operator: "above",
        threshold: "1e309",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
