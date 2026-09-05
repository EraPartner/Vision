import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePlannedTransactionRow } from "./builders/domainRows.js";

vi.mock("../src/services/plannedTransactionService.js", () => ({
  default: {
    getById: vi.fn(),
    executeAndAdvance: vi.fn().mockResolvedValue({ duplicate: false }),
  },
}));

import plannedTransactionService from "../src/services/plannedTransactionService.js";
import { executePlanned } from "../src/services/plannedExecutionService.js";

function planned(overrides = {}) {
  return makePlannedTransactionRow({
    planned_date: "2026-07-01",
    is_recurring: true,
    recurrence_pattern: "monthly",
    recurrence_end_date: null,
    max_occurrences: null,
    execution_count: 0,
    tags: [],
    ...overrides,
  });
}

function advancedFields() {
  // executeAndAdvance(id, txnId, execDate, updateFields, tagIds)
  return plannedTransactionService.executeAndAdvance.mock.calls[0][3];
}

beforeEach(() => {
  vi.clearAllMocks();
  plannedTransactionService.executeAndAdvance.mockResolvedValue({
    duplicate: false,
  });
});

describe("executePlanned — recurrence bounds (migration 0071)", () => {
  it("an unbounded recurrence advances to the next date", async () => {
    plannedTransactionService.getById.mockResolvedValue(planned());
    await executePlanned({
      id: 1,
      executedTransactionId: 9,
      executionDate: "2026-07-01",
    });

    expect(advancedFields()).toMatchObject({
      planned_date: "2026-08-01",
      is_executed: false,
    });
  });

  it("completes the series when the execution count reaches max_occurrences", async () => {
    // 11 prior executions + this one = 12 = max → done, no advance.
    plannedTransactionService.getById.mockResolvedValue(
      planned({ max_occurrences: 12, execution_count: 11 }),
    );
    await executePlanned({
      id: 1,
      executedTransactionId: 9,
      executionDate: "2026-07-01",
    });

    const fields = advancedFields();
    expect(fields.is_executed).toBe(true);
    expect(fields.planned_date).toBeUndefined();
  });

  it("keeps advancing while under max_occurrences", async () => {
    plannedTransactionService.getById.mockResolvedValue(
      planned({ max_occurrences: 12, execution_count: 3 }),
    );
    await executePlanned({
      id: 1,
      executedTransactionId: 9,
      executionDate: "2026-07-01",
    });

    expect(advancedFields()).toMatchObject({
      planned_date: "2026-08-01",
      is_executed: false,
    });
  });

  it("completes the series when the next occurrence falls past recurrence_end_date", async () => {
    // Next would be 2026-08-01 > end 2026-07-15 → done.
    plannedTransactionService.getById.mockResolvedValue(
      planned({ recurrence_end_date: "2026-07-15" }),
    );
    await executePlanned({
      id: 1,
      executedTransactionId: 9,
      executionDate: "2026-07-01",
    });

    const fields = advancedFields();
    expect(fields.is_executed).toBe(true);
    expect(fields.planned_date).toBeUndefined();
  });

  it("accepts a pg-read Date for recurrence_end_date (local-midnight shape)", async () => {
    plannedTransactionService.getById.mockResolvedValue(
      planned({ recurrence_end_date: new Date(2026, 11, 31) }), // Dec 31 local midnight
    );
    await executePlanned({
      id: 1,
      executedTransactionId: 9,
      executionDate: "2026-07-01",
    });

    // Next (Aug 1) is well before Dec 31 → advances.
    expect(advancedFields()).toMatchObject({
      planned_date: "2026-08-01",
      is_executed: false,
    });
  });
});
