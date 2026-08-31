import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  commitBatch: vi.fn(),
  reconcileTransfers: vi.fn(),
  clearForecastMcCaches: vi.fn(),
  scheduleMaterializedViewRefresh: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/database/connection.js", () => ({ query: mocks.query }));
vi.mock("../src/config/logger.js", () => ({ logger: mocks.logger }));
vi.mock("../src/services/importPipeline/stage.js", () => ({
  createBatch: vi.fn(),
  stageBatch: vi.fn(),
}));
vi.mock("../src/services/importPipeline/validate.js", () => ({
  validateBatch: vi.fn(),
}));
vi.mock("../src/services/importPipeline/match.js", () => ({
  matchBatch: vi.fn(),
}));
vi.mock("../src/services/importPipeline/commit.js", () => ({
  commitBatch: mocks.commitBatch,
}));
vi.mock("../src/services/transferReconciliationService.js", () => ({
  reconcileTransfers: mocks.reconcileTransfers,
}));
vi.mock("../src/services/aggregationRefresh.js", () => ({
  clearForecastMcCaches: mocks.clearForecastMcCaches,
  scheduleMaterializedViewRefresh: mocks.scheduleMaterializedViewRefresh,
}));

import { commitImport } from "../src/services/importPipeline/index.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("import pipeline aggregation refresh tail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.commitBatch.mockResolvedValue({
      imported: 101,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    mocks.reconcileTransfers.mockResolvedValue({ pairsCreated: 0 });
    mocks.clearForecastMcCaches.mockResolvedValue(undefined);
  });

  it("waits for reconciliation and cache invalidation, but only schedules the materialized-view rebuild", async () => {
    const reconciliation = deferred();
    const cacheClear = deferred();
    mocks.reconcileTransfers.mockReturnValue(reconciliation.promise);
    mocks.clearForecastMcCaches.mockReturnValue(cacheClear.promise);

    const resultPromise = commitImport({ batchId: 42 });
    await vi.waitFor(() =>
      expect(mocks.reconcileTransfers).toHaveBeenCalledOnce(),
    );
    expect(mocks.clearForecastMcCaches).not.toHaveBeenCalled();
    expect(mocks.scheduleMaterializedViewRefresh).not.toHaveBeenCalled();

    reconciliation.resolve({ pairsCreated: 1 });
    await vi.waitFor(() =>
      expect(mocks.clearForecastMcCaches).toHaveBeenCalledOnce(),
    );
    expect(mocks.scheduleMaterializedViewRefresh).not.toHaveBeenCalled();

    cacheClear.resolve();
    await expect(resultPromise).resolves.toMatchObject({ imported: 101 });
    expect(mocks.scheduleMaterializedViewRefresh).toHaveBeenCalledOnce();
  });

  it("skips forecast-cache invalidation for a zero-import commit but still schedules after reconciliation", async () => {
    mocks.commitBatch.mockResolvedValue({
      imported: 0,
      duplicates: 2,
      errors: 0,
      autoLinkedCount: 0,
    });

    await expect(commitImport({ batchId: 43 })).resolves.toMatchObject({
      imported: 0,
      duplicates: 2,
    });

    expect(mocks.reconcileTransfers).toHaveBeenCalledOnce();
    expect(mocks.clearForecastMcCaches).not.toHaveBeenCalled();
    expect(mocks.scheduleMaterializedViewRefresh).toHaveBeenCalledOnce();
  });

  it("keeps reconciliation and cache failures non-fatal and still schedules the rebuild", async () => {
    mocks.reconcileTransfers.mockRejectedValue(new Error("reconcile failed"));
    mocks.clearForecastMcCaches.mockRejectedValue(
      new Error("cache clear failed"),
    );

    await expect(commitImport({ batchId: 44 })).resolves.toMatchObject({
      imported: 101,
    });

    expect(mocks.clearForecastMcCaches).toHaveBeenCalledOnce();
    expect(mocks.scheduleMaterializedViewRefresh).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
  });
});
