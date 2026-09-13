/** Restricted analysis catalog, execution, drill-through, and persistence API. */

import { Router } from "express";
import {
  getAnalysisCatalog,
  compileVisualAnalysis,
} from "../services/analysisCatalog.js";
import {
  executeAnalysisSql,
  cancelAnalysisQuery,
} from "../services/analysisExecutor.js";
import {
  listSavedAnalyses,
  getSavedAnalysis,
  createSavedAnalysis,
  updateSavedAnalysis,
  runSavedAnalysis,
  deleteSavedAnalysis,
} from "../services/savedAnalysisService.js";

const router = Router();

function inputError(res, error) {
  return res.status(error.status || 400).json({
    ok: false,
    error: { code: "INVALID_ANALYSIS_REQUEST", message: error.message },
  });
}

router.get("/catalog", (_req, res) => res.ok(getAnalysisCatalog()));

router.post("/compile", (req, res) => {
  try {
    const compiled = compileVisualAnalysis(req.body);
    res.ok({
      sql: compiled.sql,
      columns: compiled.columns,
      datasetIds: compiled.datasetIds,
      visualPlan: compiled.visualPlan,
    });
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/execute", async (req, res) => {
  try {
    const source =
      req.body.mode === "visual"
        ? compileVisualAnalysis(req.body.plan)
        : {
            sql: req.body.sql,
            values: req.body.values || [],
            datasetIds: req.body.datasetIds || [],
            columns: req.body.columns || [],
          };
    const result = await executeAnalysisSql({
      requestId: req.body.requestId,
      sql: source.sql,
      values: source.values,
      datasetIds: source.datasetIds,
      limit: req.body.limit,
      offset: req.body.offset,
    });
    res.ok({
      ...result,
      generatedSql: source.sql,
      declaredColumns: source.columns,
    });
  } catch (error) {
    const status = error.code === "57014" ? 408 : 400;
    const location = error.position ? ` (SQL character ${error.position})` : "";
    res.status(status).json({
      ok: false,
      error: {
        code:
          error.code === "57014"
            ? "ANALYSIS_CANCELLED_OR_TIMED_OUT"
            : "ANALYSIS_EXECUTION_REJECTED",
        message: `${error.message}${location}`,
      },
    });
  }
});

router.post("/cancel/:requestId", async (req, res) => {
  try {
    res.ok(await cancelAnalysisQuery(req.params.requestId));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/drill", async (req, res) => {
  try {
    const catalog = getAnalysisCatalog();
    const dataset = catalog.datasets.find(
      (entry) => entry.id === req.body.plan?.datasetId,
    );
    if (!dataset) throw new Error("Unknown drill-through dataset");
    const primaryKey = {
      transactions: "transaction_id",
      accounts: "account_id",
      holdings: "event_id",
      "cash-flows": "cash_flow_id",
    }[dataset.id];
    const groups = req.body.plan.groups || [];
    const filters = [
      ...(req.body.plan.filters || []),
      ...groups.map((fieldId) => ({
        fieldId,
        operator: "eq",
        value: req.body.row?.[fieldId],
      })),
    ];
    const fields = [
      primaryKey,
      ...dataset.fields
        .map((field) => field.id)
        .filter((id) => id !== primaryKey)
        .slice(0, 7),
    ];
    const compiled = compileVisualAnalysis({
      datasetId: dataset.id,
      fields,
      filters,
      groups: [],
      measures: [],
      orderBy: [{ id: primaryKey, direction: "asc" }],
      limit: 100,
    });
    const result = await executeAnalysisSql({
      requestId: req.body.requestId,
      sql: compiled.sql,
      values: compiled.values,
      datasetIds: compiled.datasetIds,
      limit: 100,
    });
    res.ok({
      ...result,
      generatedSql: compiled.sql,
      declaredColumns: compiled.columns,
    });
  } catch (error) {
    inputError(res, error);
  }
});

router.get("/saved", async (req, res) => {
  try {
    const items = await listSavedAnalyses(req.query.workspace);
    res.ok({ items, total: items.length });
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/saved", async (req, res) => {
  try {
    res.status(201);
    res.ok(await createSavedAnalysis(req.body));
  } catch (error) {
    inputError(res, error);
  }
});
router.get("/saved/:id", async (req, res) => {
  const saved = await getSavedAnalysis(req.params.id);
  if (!saved)
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Saved analysis not found" },
    });
  res.ok(saved);
});
router.put("/saved/:id", async (req, res) => {
  try {
    res.ok(await updateSavedAnalysis(req.params.id, req.body));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/saved/:id/run", async (req, res) => {
  try {
    res.ok(await runSavedAnalysis(req.params.id));
  } catch (error) {
    inputError(res, error);
  }
});
router.delete("/saved/:id", async (req, res) => {
  if (!(await deleteSavedAnalysis(req.params.id)))
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Saved analysis not found" },
    });
  res.status(204).end();
});

export default router;
