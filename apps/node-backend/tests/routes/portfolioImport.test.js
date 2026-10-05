/**
 * Portfolio import route tests.
 *
 * Focused on the batch/row id guards: ids are positive bigserial PKs, so
 * non-positive or trailing-garbage values must 400 before touching the DB
 * (previously "-1"/"0"/"12abc" slipped through as NaN-tolerant parseInt).
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js), which also puts the router's own trailing error
 * middleware (`router.use(csvUploadErrorTranslator)`, routes/
 * portfolioImportRoutes.js:494) on the tested path — the mock-router harness
 * dropped it entirely. multer is still stubbed to a pass-through (no real
 * multipart parsing); this suite doesn't exercise the upload routes, so no
 * `req.file` injection is needed (see portfolioImportValidationPins.test.js
 * for that, mirroring importValidationPins.test.js's pattern).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, okEnvelope, errEnvelope } from "../helpers/routeApp.js";

vi.mock("multer", () => {
  const multer = vi.fn(() => ({
    single: vi.fn(() => (req, res, next) => next()),
  }));
  multer.MulterError = class MulterError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  };
  return { default: multer };
});

vi.mock("fs", () => {
  const unlink = vi.fn().mockResolvedValue(undefined);
  return {
    default: {
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      promises: { unlink },
    },
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    promises: { unlink },
  };
});

vi.mock("os", () => ({
  default: { tmpdir: vi.fn(() => "/tmp") },
  tmpdir: vi.fn(() => "/tmp"),
}));

vi.mock("../../src/services/portfolioImportPipeline/index.js", () => ({
  runPortfolioImportPipeline: vi.fn(),
}));

vi.mock("../../src/services/portfolioImportCommitService.js", () => ({
  commitReviewedPortfolioImport: vi.fn(),
  commitReviewedPortfolioImports: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportReconciliationService.js", () => ({
  previewPortfolioImportReconciliation: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportReferenceService.js", () => ({
  applyPortfolioImportReference: vi.fn(),
}));

vi.mock("../../src/services/portfolioImportBatchService.js", () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  getPortfolioImportBatchPreview: vi.fn(),
  overrideInvestment: vi.fn(),
  createInvestmentForRow: vi.fn(),
  resolveInvestmentRows: vi.fn(),
  rollbackBatch: vi.fn(),
}));

vi.mock("../../src/services/accountService.js", () => ({
  default: { get: vi.fn() },
}));

vi.mock("../../src/repositories/customParserConfigRepository.js", () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/database/connection.js", () => mockConnection());

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

import {
  getBatch,
  getPortfolioImportBatchPreview,
  listBatches,
  createInvestmentForRow,
  resolveInvestmentRows,
  rollbackBatch,
} from "../../src/services/portfolioImportBatchService.js";
import { commitReviewedPortfolioImports } from "../../src/services/portfolioImportCommitService.js";
import { previewPortfolioImportReconciliation } from "../../src/services/portfolioImportReconciliationService.js";
import { ConflictError } from "../../src/middleware/errorHandler.js";

const { default: portfolioImportRouter } =
  await import("../../src/routes/portfolioImportRoutes.js");

const BASE = "/api/portfolio/import";
const api = routeAgent(portfolioImportRouter, { mountPath: BASE });

describe("Portfolio import reconciliation HTTP contract", () => {
  beforeEach(() => vi.clearAllMocks());
  it("accepts safe bigserial batch IDs above the account-ID range", async () => {
    previewPortfolioImportReconciliation.mockResolvedValue({
      ready: false,
      blockers: [],
    });
    await api
      .post(`${BASE}/reconciliation/preview`)
      .send({ batch_ids: [2147483648, Number.MAX_SAFE_INTEGER] })
      .expect(200);
    expect(previewPortfolioImportReconciliation).toHaveBeenCalledWith({
      batchIds: [2147483648, Number.MAX_SAFE_INTEGER],
      adoptPolicy: undefined,
      batchPolicies: undefined,
    });
  });
  it("previews the requested complete scope and policy without committing", async () => {
    previewPortfolioImportReconciliation.mockResolvedValue({
      ready: false,
      blockers: [],
    });
    await api
      .post(`${BASE}/reconciliation/preview`)
      .send({ batch_ids: [4, 7], adopt_policy: "preserve_existing" })
      .expect(200);
    expect(previewPortfolioImportReconciliation).toHaveBeenCalledWith({
      batchIds: [4, 7],
      adoptPolicy: "preserve_existing",
      batchPolicies: undefined,
    });
    expect(commitReviewedPortfolioImports).not.toHaveBeenCalled();
  });
  it("passes explicit per-batch policies with the reviewed scope", async () => {
    previewPortfolioImportReconciliation.mockResolvedValue({
      ready: false,
      blockers: [],
    });
    await api
      .post(`${BASE}/reconciliation/preview`)
      .send({
        batch_ids: [4, 7],
        adopt_policy: "preserve_existing",
        batch_policies: [{ batch_id: 7, adopt_policy: "prefer_source" }],
      })
      .expect(200);
    expect(previewPortfolioImportReconciliation).toHaveBeenCalledWith({
      batchIds: [4, 7],
      adoptPolicy: "preserve_existing",
      batchPolicies: [{ batchId: 7, adoptPolicy: "prefer_source" }],
    });
    commitReviewedPortfolioImports.mockResolvedValue({
      batches: [],
      imported: 0,
      adopted: 0,
      duplicates: 0,
    });
    const hash = "b".repeat(64);
    await api
      .post(`${BASE}/reconciliation/commit`)
      .send({
        batch_ids: [4, 7],
        batch_policies: [{ batch_id: 7, adopt_policy: "prefer_source" }],
        expected_plan_fingerprint: hash,
      })
      .expect(200);
    expect(commitReviewedPortfolioImports).toHaveBeenCalledWith({
      batchIds: [4, 7],
      adoptPolicy: undefined,
      batchPolicies: [{ batchId: 7, adoptPolicy: "prefer_source" }],
      expectedPlanFingerprint: hash,
    });
  });
  it.each([
    { batch_ids: [] },
    { batch_ids: ["7"] },
    { batch_ids: [0] },
    { batch_ids: [1.5] },
    { batch_ids: [9007199254740992] },
    { batch_ids: Array.from({ length: 101 }, (_, i) => i + 1) },
    { batch_ids: [7], adopt_policy: "guess" },
    { batch_ids: [7], unknown_account: 8 },
    {
      batch_ids: [7],
      batch_policies: [{ batch_id: "7", adopt_policy: "prefer_source" }],
    },
    {
      batch_ids: [7],
      batch_policies: [{ batch_id: 7, adopt_policy: "guess" }],
    },
    {
      batch_ids: [7],
      batch_policies: [
        { batch_id: 7, adopt_policy: "prefer_source", unexpected: true },
      ],
    },
  ])("rejects malformed or ambiguous preview scope %j", async (body) => {
    await api.post(`${BASE}/reconciliation/preview`).send(body).expect(400);
    expect(previewPortfolioImportReconciliation).not.toHaveBeenCalled();
  });
  it("requires the reviewed fingerprint before commit", async () => {
    await api
      .post(`${BASE}/reconciliation/commit`)
      .send({ batch_ids: [7] })
      .expect(400);
    await api
      .post(`${BASE}/reconciliation/commit`)
      .send({ batch_ids: [7], expected_plan_fingerprint: "unreviewed" })
      .expect(400);
    expect(commitReviewedPortfolioImports).not.toHaveBeenCalled();
  });
  it("passes the fingerprint and returns a stale-plan conflict", async () => {
    commitReviewedPortfolioImports.mockRejectedValue(
      new ConflictError("Reconciliation preview changed"),
    );
    const hash = "a".repeat(64);
    const response = await api
      .post(`${BASE}/reconciliation/commit`)
      .send({
        batch_ids: [4, 7],
        adopt_policy: "prefer_source",
        expected_plan_fingerprint: hash,
      })
      .expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(commitReviewedPortfolioImports).toHaveBeenCalledWith({
      batchIds: [4, 7],
      adoptPolicy: "prefer_source",
      batchPolicies: undefined,
      expectedPlanFingerprint: hash,
    });
  });
});

function routeHandler(method, path) {
  const layer = portfolioImportRouter.stack.find(
    (candidate) =>
      candidate.route?.path === path && candidate.route.methods[method],
  );
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

describe("Portfolio Import Routes — batch/row id guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /batches/:id/preview rejects a negative batch id with a 400", async () => {
    const res = await api.get(`${BASE}/batches/-1/preview`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(getBatch).not.toHaveBeenCalled();
    expect(getPortfolioImportBatchPreview).not.toHaveBeenCalled();
  });

  it('GET /batches/:id rejects a trailing-garbage id like "12abc"', async () => {
    const res = await api.get(`${BASE}/batches/12abc`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(getBatch).not.toHaveBeenCalled();
  });

  it("POST /batches/:id/rows/:rowId/investment-override rejects a zero rowId", async () => {
    const res = await api
      .post(`${BASE}/batches/5/rows/0/investment-override`)
      .send({})
      .expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("maps a missing create-new row from the legacy endpoint to 404", async () => {
    createInvestmentForRow.mockRejectedValue(
      Object.assign(new Error("Row not found"), { code: "NOT_FOUND" }),
    );

    const res = await api
      .post(`${BASE}/batches/5/rows/6/investment-override`)
      .send({ create_new: true })
      .expect(404);

    expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
  });
});

describe("Portfolio Import Routes — collection response shape", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /batches returns the canonical { items, total, limit, offset } body", async () => {
    listBatches.mockResolvedValue({
      batches: [{ id: 1, status: "complete" }],
      total: 1,
    });

    const res = await api.get(`${BASE}/batches`).expect(200);

    // The old `batches` wire key is gone; the service still speaks `batches`.
    expect(res.body.data.batches).toBeUndefined();
    expect(res.body).toEqual(
      okEnvelope({
        items: [{ id: 1, status: "complete" }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    );
  });
});

describe("Portfolio Import Routes — batch detail and rollback parity (listener-free)", () => {
  const detailHandler = routeHandler("get", "/batches/:id");
  const rollbackHandler = routeHandler("delete", "/batches/:id");

  beforeEach(() => vi.clearAllMocks());

  it("returns a batch and preserves the shared missing-batch error", async () => {
    getBatch
      .mockResolvedValueOnce({ id: 4, status: "complete" })
      .mockResolvedValueOnce(null);
    const res = { ok: vi.fn() };

    await detailHandler({ params: { id: "4" } }, res);
    expect(res.ok).toHaveBeenCalledWith({ id: 4, status: "complete" });
    await expect(
      detailHandler({ params: { id: "5" } }, res),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("blocks pending before the portfolio rollback service", async () => {
    getBatch.mockResolvedValue({ id: 4, status: "pending" });
    await expect(
      rollbackHandler({ params: { id: "4" } }, { ok: vi.fn() }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(rollbackBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["VALIDATION_ERROR", "VALIDATION_ERROR"],
    ["NOT_FOUND", "NOT_FOUND"],
  ])(
    "maps a service-coded %s rollback error",
    async (serviceCode, expectedCode) => {
      getBatch.mockResolvedValue({ id: 4, status: "complete" });
      rollbackBatch.mockRejectedValue(
        Object.assign(new Error("locked recheck"), { code: serviceCode }),
      );

      await expect(
        rollbackHandler({ params: { id: "4" } }, { ok: vi.fn() }),
      ).rejects.toMatchObject({
        code: expectedCode,
        message: "locked recheck",
      });
    },
  );

  it("returns only the portfolio deleted count", async () => {
    getBatch.mockResolvedValue({ id: 4, status: "complete" });
    rollbackBatch.mockResolvedValue({ deleted: 3, recipientsRemoved: 99 });
    const res = { ok: vi.fn() };

    await rollbackHandler({ params: { id: "4" } }, res);

    expect(res.ok).toHaveBeenCalledWith({ deleted: 3 });
  });
});

describe("Portfolio Import Routes — bulk investment resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a complete row set through one service call", async () => {
    resolveInvestmentRows.mockResolvedValue({
      investmentId: 42,
      created: false,
      resolved: 3,
    });

    const res = await api
      .post(`${BASE}/batches/5/rows/investment-override`)
      .send({ row_ids: [10, 11, 12], investment_id: 42 })
      .expect(200);

    expect(resolveInvestmentRows).toHaveBeenCalledTimes(1);
    expect(resolveInvestmentRows).toHaveBeenCalledWith({
      batchId: 5,
      rowIds: [10, 11, 12],
      investmentId: 42,
      createNew: false,
    });
    expect(res.body).toEqual(
      okEnvelope({ investment_id: 42, created: false, resolved: 3 }),
    );
  });

  it("rejects malformed, duplicate, or ambiguous row-set bodies before the service", async () => {
    const invalidBodies = [
      { row_ids: [], investment_id: 42 },
      { row_ids: [10, "11abc"], investment_id: 42 },
      { row_ids: [10, 10], investment_id: 42 },
      { row_ids: [10] },
      { row_ids: [10], investment_id: 42, create_new: true },
      { row_ids: [10], investment_id: 42, create_new: false },
    ];

    for (const body of invalidBodies) {
      await api
        .post(`${BASE}/batches/5/rows/investment-override`)
        .send(body)
        .expect(400);
    }

    expect(resolveInvestmentRows).not.toHaveBeenCalled();
  });

  it("maps an ineligible row set to 404 without reporting partial success", async () => {
    const err = Object.assign(
      new Error("One or more rows are no longer reviewable"),
      {
        code: "NOT_FOUND",
      },
    );
    resolveInvestmentRows.mockRejectedValue(err);

    const res = await api
      .post(`${BASE}/batches/5/rows/investment-override`)
      .send({ row_ids: [10, 11], create_new: true })
      .expect(404);

    expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
  });
});
