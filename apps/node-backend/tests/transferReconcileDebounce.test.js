import { afterEach, describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";
import { mockTxConnection } from "./helpers/repoMocks.js";
// scheduleReconcile debounce (TODO E20): the old trailing-only 1s window only
// coalesced edits made <1s apart — human editing cadence paid a full-corpus
// reconcile per save — and a steady mutation stream deferred it indefinitely.

async function loadService() {
  vi.resetModules();

  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const scheduleAggregationRefresh = vi.fn();

  vi.doMock("../src/database/connection.js", () =>
    mockTxConnection({ query }, { query }),
  );
  vi.doMock("../src/config/logger.js", () => ({
    logger: mockLogger(),
  }));
  vi.doMock("../src/services/aggregationRefresh.js", () => ({
    scheduleAggregationRefresh,
  }));

  const service =
    await import("../src/services/transferReconciliationService.js");
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

describe("releaseOrphans scope", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("only releases reconciler-owned rows, never system rows (opening/adjustment/trade)", async () => {
    const { reconcileTransfers, query } = await loadService();
    await reconcileTransfers();

    const orphanUpdate = query.mock.calls
      .map((c) => c[0])
      .find((sql) =>
        /SET is_transfer = false, transfer_source = NULL\s+WHERE is_transfer = true AND transfer_peer_id IS NULL/.test(
          sql,
        ),
      );

    expect(orphanUpdate).toBeDefined();
    // The fix: constrain to 'auto'/'manual' so an opening anchor keeps its tag
    // and an adjustment row is not flipped back into income/spending aggregates.
    expect(orphanUpdate).toMatch(/transfer_source IN \('auto', 'manual'\)/);
  });
});
