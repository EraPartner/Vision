import { afterEach, describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
// scheduleReconcile debounce (TODO E20): the old trailing-only 1s window only
// coalesced edits made <1s apart — human editing cadence paid a full-corpus
// reconcile per save — and a steady mutation stream deferred it indefinitely.

async function loadService() {
  vi.resetModules();

  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [],
    rowCount: 0,
  }));
  const scheduleAggregationRefresh = vi.fn();

  vi.doMock("../src/database/connection.ts", () =>
    mockTxConnection({ query }, { query }),
  );
  vi.doMock("../src/config/logger.ts", () => ({
    logger: mockLogger(),
  }));
  vi.doMock("../src/services/aggregationRefresh.ts", () => ({
    scheduleAggregationRefresh,
  }));

  const service =
    await import("../src/services/transferReconciliationService.ts");
  return { ...service, query, scheduleAggregationRefresh };
}

describe("scheduleReconcile debounce", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("coalesces a burst into one reconcile after the trailing window", async () => {
    vi.useFakeTimers();
    const {
      scheduleReconcile,
      query,
      scheduleAggregationRefresh,
      RECONCILE_DEBOUNCE_MS,
    } = await loadService();

    scheduleReconcile();
    scheduleReconcile();
    scheduleReconcile();

    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS - 1);
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalled();
    expect(scheduleAggregationRefresh).toHaveBeenCalledTimes(1);
  });

  it("flushes at the max-wait cap under a steady mutation stream", async () => {
    vi.useFakeTimers();
    const { scheduleReconcile, query, RECONCILE_MAX_WAIT_MS } =
      await loadService();

    // Reschedule every 2s — always inside the 5s trailing window, so without
    // the max-wait cap this would never fire.
    const step = 2000;
    scheduleReconcile();
    for (
      let elapsed = 0;
      elapsed < RECONCILE_MAX_WAIT_MS - step;
      elapsed += step
    ) {
      await vi.advanceTimersByTimeAsync(step);
      scheduleReconcile();
    }
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(step);
    expect(query).toHaveBeenCalled();
  });
});
