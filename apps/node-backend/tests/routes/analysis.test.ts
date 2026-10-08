/**
 * Analysis route request validation (ADR-193).
 *
 * Runs the REAL router on a throwaway Express app (tests/helpers/routeApp.ts).
 * The pure catalog compiler, workbench and formula engine run for real; the
 * executor, saved-analysis persistence, AI proposals and pivot service are
 * mocked so each case only exercises the HTTP boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.ts";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/database/connection.ts", () => mockConnection());

vi.mock("../../src/services/analysisExecutor.ts", () => ({
  executeAnalysisSql: vi.fn(),
  cancelAnalysisQuery: vi.fn(),
}));

vi.mock("../../src/services/savedAnalysisService.ts", () => ({
  listSavedAnalyses: vi.fn(),
  getSavedAnalysis: vi.fn(),
  createSavedAnalysis: vi.fn(),
  updateSavedAnalysis: vi.fn(),
  runSavedAnalysis: vi.fn(),
  deleteSavedAnalysis: vi.fn(),
  listSavedAnalysisVersions: vi.fn(),
  restoreSavedAnalysisVersion: vi.fn(),
}));

vi.mock("../../src/services/aiAnalysisProposalService.ts", () => ({
  previewAnalysisProposal: vi.fn(),
  applyAnalysisProposal: vi.fn(),
  generateAnalysisProposal: vi.fn(),
}));

vi.mock("../../src/services/analysisPivotService.ts", () => ({
  executeAnalysisPivot: vi.fn(),
}));

import {
  cancelAnalysisQuery,
  executeAnalysisSql,
} from "../../src/services/analysisExecutor.ts";
import {
  createSavedAnalysis,
  getSavedAnalysis,
  listSavedAnalyses,
  restoreSavedAnalysisVersion,
  updateSavedAnalysis,
} from "../../src/services/savedAnalysisService.ts";
import {
  generateAnalysisProposal,
  previewAnalysisProposal,
} from "../../src/services/aiAnalysisProposalService.ts";
import { executeAnalysisPivot } from "../../src/services/analysisPivotService.ts";

type SqlResult = Awaited<ReturnType<typeof executeAnalysisSql>>;

const { default: analysisRouter } =
  await import("../../src/routes/analysis.ts");

const api = routeAgent(analysisRouter, { mountPath: "/api/analysis" });
const BASE = "/api/analysis";
const REQUEST_ID = "request-0001";

const PLAN = {
  datasetId: "cash-flows",
  fields: ["month", "currency"],
  groups: ["month", "currency"],
  measures: ["sum_spending"],
  joins: [],
  filters: [{ fieldId: "is_transfer", operator: "eq", value: false }],
  orderBy: [{ id: "month", direction: "asc" }],
  limit: 500,
};

const SQL_RESULT: SqlResult = {
  requestId: REQUEST_ID,
  startedAt: "2026-10-08T00:00:00.000Z",
  completedAt: "2026-10-08T00:00:00.010Z",
  executor: "analysis-sql",
  rows: [{ month: "2026-09-01", currency: "EUR", sum_spending: "12.50" }],
  columns: [
    { id: "month", type: "date" },
    { id: "currency", type: "currency" },
    { id: "sum_spending", type: "decimal" },
  ],
  window: {
    kind: "page",
    offset: 0,
    limit: 500,
    hasMore: false,
    returnedRows: 1,
  },
  byteLength: 64,
};

function expectValidationError(
  res: { body: unknown },
  message?: string | RegExp,
) {
  expect(res.body).toEqual(
    errEnvelope({
      code: "VALIDATION_ERROR",
      ...(message === undefined
        ? {}
        : {
            message:
              typeof message === "string"
                ? message
                : expect.stringMatching(message),
          }),
    }),
  );
}

describe("Analysis routes request validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeAnalysisSql).mockResolvedValue(SQL_RESULT);
  });

  describe("POST /compile", () => {
    it("compiles a valid plan and echoes unknown plan keys", async () => {
      const res = await api
        .post(`${BASE}/compile`)
        .send({ ...PLAN, chartHint: "bar" })
        .expect(200);
      expect(res.body.data.datasetIds).toEqual(["cash-flows"]);
      expect(res.body.data.visualPlan.chartHint).toBe("bar");
    });

    it("rejects a missing dataset and malformed plan lists", async () => {
      expectValidationError(
        await api.post(`${BASE}/compile`).send({}).expect(400),
        /^datasetId: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/compile`)
          .send({ ...PLAN, fields: "month" })
          .expect(400),
        /^fields: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/compile`)
          .send({ ...PLAN, orderBy: [{ id: "month", direction: "DESC" }] })
          .expect(400),
        /^orderBy\.0\.direction: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/compile`)
          .send({
            ...PLAN,
            filters: [{ fieldId: "currency", operator: "eq", value: {} }],
          })
          .expect(400),
        /^filters\.0\.value: /,
      );
    });

    it("keeps catalog rejections as INVALID_ANALYSIS_REQUEST", async () => {
      const res = await api
        .post(`${BASE}/compile`)
        .send({ ...PLAN, datasetId: "nope" })
        .expect(400);
      expect(res.body).toEqual(
        errEnvelope({
          code: "INVALID_ANALYSIS_REQUEST",
          message: "Unsupported analysis dataset: nope",
        }),
      );
    });
  });

  describe("POST /execute", () => {
    it("runs custom SQL when mode is omitted", async () => {
      await api
        .post(`${BASE}/execute`)
        .send({ requestId: REQUEST_ID, sql: "SELECT 1", values: [1, "a"] })
        .expect(200);
      expect(executeAnalysisSql).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: REQUEST_ID,
          sql: "SELECT 1",
          values: [1, "a"],
          datasetIds: [],
        }),
      );
    });

    it("compiles a visual plan before executing it", async () => {
      await api
        .post(`${BASE}/execute`)
        .send({ requestId: REQUEST_ID, mode: "visual", plan: PLAN, offset: 0 })
        .expect(200);
      expect(executeAnalysisSql).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 500, offset: 0 }),
      );
    });

    it("treats null plan options as absent, as a saved plan edited by an AI proposal can carry them", async () => {
      await api
        .post(`${BASE}/execute`)
        .send({
          requestId: REQUEST_ID,
          mode: "visual",
          plan: { ...PLAN, limit: null, reportingCurrency: null, from: null },
        })
        .expect(200);
      expect(executeAnalysisSql).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 500 }),
      );
    });

    it("rejects a non-string SQL text before it reaches the executor", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/execute`)
          .send({ requestId: REQUEST_ID, mode: "sql", sql: { text: 1 } })
          .expect(400),
        /^sql: /,
      );
      expect(executeAnalysisSql).not.toHaveBeenCalled();
    });

    it("rejects a visual run without a plan", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/execute`)
          .send({ requestId: REQUEST_ID, mode: "visual" })
          .expect(400),
        /^plan: /,
      );
    });

    it("rejects an unknown mode, non-scalar values and non-numeric paging", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/execute`)
          .send({ mode: "python", sql: "SELECT 1" })
          .expect(400),
        /^mode: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/execute`)
          .send({ sql: "SELECT 1", values: [{ a: 1 }] })
          .expect(400),
        /^values\.0: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/execute`)
          .send({ sql: "SELECT 1", limit: "10" })
          .expect(400),
        /^limit: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/execute`)
          .send({ sql: "SELECT 1", workbench: { steps: "all" } })
          .expect(400),
        /^workbench\.steps: /,
      );
      expect(executeAnalysisSql).not.toHaveBeenCalled();
    });

    it("keeps executor rejections and timeouts on their analysis codes", async () => {
      vi.mocked(executeAnalysisSql).mockRejectedValueOnce(
        Object.assign(new Error('relation "x" does not exist'), {
          code: "42P01",
          position: "15",
        }),
      );
      const rejected = await api
        .post(`${BASE}/execute`)
        .send({ requestId: REQUEST_ID, sql: "SELECT * FROM x" })
        .expect(400);
      expect(rejected.body).toEqual(
        errEnvelope({
          code: "ANALYSIS_EXECUTION_REJECTED",
          message: 'relation "x" does not exist (SQL character 15)',
        }),
      );

      vi.mocked(executeAnalysisSql).mockRejectedValueOnce(
        Object.assign(new Error("canceling statement"), { code: "57014" }),
      );
      const cancelled = await api
        .post(`${BASE}/execute`)
        .send({ requestId: REQUEST_ID, sql: "SELECT 1" })
        .expect(408);
      expect(cancelled.body.error.code).toBe("ANALYSIS_CANCELLED_OR_TIMED_OUT");
    });

    it("reports a database outage as a server fault, not a rejected query", async () => {
      vi.mocked(executeAnalysisSql).mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        }),
      );
      const res = await api
        .post(`${BASE}/execute`)
        .send({ requestId: REQUEST_ID, sql: "SELECT 1" })
        .expect(500);
      expect(res.body.error.code).not.toBe("ANALYSIS_EXECUTION_REJECTED");
    });
  });

  describe("POST /pivot", () => {
    it("passes a valid pivot request to the service", async () => {
      vi.mocked(executeAnalysisPivot).mockResolvedValue({
        levels: [],
        partitions: [],
        config: { rows: [], columns: [], values: [] },
        coverage: { complete: true, rows: 0 },
      } as never);
      await api
        .post(`${BASE}/pivot`)
        .send({
          plan: PLAN,
          config: { rows: ["month"], columns: [], values: ["sum_spending"] },
          requestId: REQUEST_ID,
        })
        .expect(200);
      expect(executeAnalysisPivot).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: REQUEST_ID }),
        expect.objectContaining({ catalog: expect.any(Object) }),
      );
    });

    it("rejects a missing plan and non-list axes", async () => {
      expectValidationError(
        await api.post(`${BASE}/pivot`).send({ config: {} }).expect(400),
        /^plan: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/pivot`)
          .send({ plan: PLAN, config: { rows: "month" } })
          .expect(400),
        /^config\.rows: /,
      );
      expect(executeAnalysisPivot).not.toHaveBeenCalled();
    });
  });

  describe("POST /extensions/evaluate", () => {
    it("evaluates a valid formula extension", async () => {
      const res = await api
        .post(`${BASE}/extensions/evaluate`)
        .send({
          operation: "formulas",
          rows: [{ amount: "2" }],
          columns: [{ id: "amount", type: "decimal" }],
          complete: true,
          formulas: [{ id: "double", scope: "row", expression: "amount * 2" }],
        })
        .expect(200);
      expect(res.body.data.rows[0].double).toBe("4");
    });

    it("rejects an unknown operation and non-array rows", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/extensions/evaluate`)
          .send({ operation: "exec", rows: [] })
          .expect(400),
        /^operation: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/extensions/evaluate`)
          .send({ operation: "prepare", rows: "all" })
          .expect(400),
        /^rows: /,
      );
    });
  });

  describe("POST /formulas/evaluate", () => {
    it("evaluates formulas over valid rows", async () => {
      const res = await api
        .post(`${BASE}/formulas/evaluate`)
        .send({
          rows: [{ amount: "3" }],
          formulas: [{ id: "triple", scope: "row", expression: "amount * 3" }],
        })
        .expect(200);
      expect(res.body.data.rows[0].triple).toBe("9");
    });

    it("rejects a missing row set and non-object formulas", async () => {
      expectValidationError(
        await api.post(`${BASE}/formulas/evaluate`).send({}).expect(400),
        /^rows: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/formulas/evaluate`)
          .send({ rows: [], formulas: ["amount * 3"] })
          .expect(400),
        /^formulas\.0: /,
      );
    });
  });

  describe("POST /cancel/:requestId", () => {
    it("cancels a well-formed request id", async () => {
      vi.mocked(cancelAnalysisQuery).mockResolvedValue({
        cancelled: false,
        reason: "not-running",
      });
      await api.post(`${BASE}/cancel/${REQUEST_ID}`).expect(200);
      expect(cancelAnalysisQuery).toHaveBeenCalledWith(REQUEST_ID);
    });

    it("rejects a request id the executor could never have issued", async () => {
      expectValidationError(
        await api.post(`${BASE}/cancel/short`).expect(400),
        /^requestId: /,
      );
      expect(cancelAnalysisQuery).not.toHaveBeenCalled();
    });
  });

  describe("POST /drill", () => {
    it("drills a grouped row into its contributing records", async () => {
      await api
        .post(`${BASE}/drill`)
        .send({
          plan: PLAN,
          row: { month: "2026-09-01", currency: null },
          requestId: REQUEST_ID,
        })
        .expect(200);
      const request = vi.mocked(executeAnalysisSql).mock.calls[0][0];
      expect(request.limit).toBe(100);
      expect(request.values).toContain("2026-09-01");
    });

    it("rejects a missing plan and a non-object row", async () => {
      expectValidationError(
        await api.post(`${BASE}/drill`).send({ row: {} }).expect(400),
        /^plan: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/drill`)
          .send({ plan: PLAN, row: ["2026-09-01"] })
          .expect(400),
        /^row: /,
      );
      expect(executeAnalysisSql).not.toHaveBeenCalled();
    });
  });

  describe("AI proposals", () => {
    const proposal = {
      schemaVersion: 1,
      savedAnalysisId: "saved-1",
      baseVersion: 2,
      rationale: "Rename it",
      operations: [{ op: "replace", path: "/name", value: "Renamed" }],
    };

    it("previews a well-formed proposal", async () => {
      vi.mocked(previewAnalysisProposal).mockResolvedValue({} as never);
      await api.post(`${BASE}/ai-proposals/preview`).send(proposal).expect(200);
      expect(previewAnalysisProposal).toHaveBeenCalledWith(proposal);
    });

    it("rejects a proposal outside the shared contract", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/ai-proposals/preview`)
          .send({ ...proposal, operations: [{ op: "move", path: "/name" }] })
          .expect(400),
        /^operations\.0\.op: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/ai-proposals/apply`)
          .send({ ...proposal, extra: true })
          .expect(400),
      );
      expect(previewAnalysisProposal).not.toHaveBeenCalled();
    });

    it("rejects an empty or non-string AI instruction", async () => {
      expectValidationError(
        await api
          .post(`${BASE}/saved/saved-1/ai-proposal`)
          .send({ instruction: "   " })
          .expect(400),
        "instruction: AI edit instruction must contain 1 to 2000 characters",
      );
      expectValidationError(
        await api
          .post(`${BASE}/saved/saved-1/ai-proposal`)
          .send({ instruction: 42 })
          .expect(400),
        /^instruction: /,
      );
      expect(generateAnalysisProposal).not.toHaveBeenCalled();
    });

    it("passes a trimmed instruction and model to the generator", async () => {
      vi.mocked(generateAnalysisProposal).mockResolvedValue({} as never);
      await api
        .post(`${BASE}/saved/saved-1/ai-proposal`)
        .send({ instruction: "  add a filter ", model: "llama" })
        .expect(200);
      expect(generateAnalysisProposal).toHaveBeenCalledWith({
        savedAnalysisId: "saved-1",
        instruction: "add a filter",
        model: "llama",
      });
    });
  });

  describe("saved analyses", () => {
    const input = {
      name: "Spending",
      workspace: "budgeting",
      querySpec: { mode: "visual", plan: PLAN },
      refreshMode: "live",
      parameters: { currency: "EUR" },
      charts: [],
      formulas: [],
      assumptions: [],
      assumptionValues: {},
    };

    it("lists by a known workspace and rejects an unknown one", async () => {
      vi.mocked(listSavedAnalyses).mockResolvedValue([]);
      await api
        .get(`${BASE}/saved`)
        .query({ workspace: "portfolio" })
        .expect(200);
      expect(listSavedAnalyses).toHaveBeenCalledWith("portfolio");
      expectValidationError(
        await api.get(`${BASE}/saved`).query({ workspace: "nope" }).expect(400),
        /^workspace: /,
      );
      expectValidationError(
        await api
          .get(`${BASE}/saved`)
          .query("workspace=portfolio&workspace=research")
          .expect(400),
        /^workspace: /,
      );
    });

    it("creates a saved analysis from a valid definition", async () => {
      vi.mocked(createSavedAnalysis).mockResolvedValue({} as never);
      await api.post(`${BASE}/saved`).send(input).expect(201);
      expect(createSavedAnalysis).toHaveBeenCalledWith(input);
    });

    it("rejects a definition without a query spec or with an unknown workspace", async () => {
      const { querySpec: _querySpec, ...withoutQuery } = input;
      expectValidationError(
        await api.post(`${BASE}/saved`).send(withoutQuery).expect(400),
        /^querySpec: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/saved`)
          .send({ ...input, workspace: "taxes" })
          .expect(400),
        /^workspace: /,
      );
      expectValidationError(
        await api
          .post(`${BASE}/saved`)
          .send({ ...input, querySpec: { mode: "sql", sql: "SELECT 1" } })
          .expect(400),
        /^querySpec\.datasetIds: /,
      );
      expect(createSavedAnalysis).not.toHaveBeenCalled();
    });

    it("requires a query spec on update", async () => {
      vi.mocked(updateSavedAnalysis).mockResolvedValue({} as never);
      await api
        .put(`${BASE}/saved/saved-1`)
        .send({ querySpec: input.querySpec, expectedVersion: 2 })
        .expect(200);
      expect(updateSavedAnalysis).toHaveBeenCalledWith("saved-1", {
        querySpec: input.querySpec,
        expectedVersion: 2,
      });
      expectValidationError(
        await api.put(`${BASE}/saved/saved-1`).send({ name: "x" }).expect(400),
        /^querySpec: /,
      );
    });

    it("restores only explicit positive integer versions", async () => {
      vi.mocked(restoreSavedAnalysisVersion).mockResolvedValue({} as never);
      await api
        .post(`${BASE}/saved/saved-1/restore`)
        .send({ version: 1, expectedVersion: 3 })
        .expect(200);
      expect(restoreSavedAnalysisVersion).toHaveBeenCalledWith("saved-1", 1, 3);
      expectValidationError(
        await api
          .post(`${BASE}/saved/saved-1/restore`)
          .send({ version: "1; DROP" })
          .expect(400),
        /^version: /,
      );
    });

    it("reports a lost database connection as a server fault", async () => {
      vi.mocked(listSavedAnalyses).mockRejectedValueOnce(
        Object.assign(new Error("terminating connection"), { code: "57P01" }),
      );
      await api.get(`${BASE}/saved`).expect(500);

      vi.mocked(getSavedAnalysis).mockResolvedValueOnce(null);
      await api.get(`${BASE}/saved/missing`).expect(404);
    });
  });
});
