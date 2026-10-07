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
  listSavedAnalysisVersions,
  restoreSavedAnalysisVersion,
} from "../services/savedAnalysisService.js";
import { evaluateAnalysisFormulas } from "../services/analysisFormulaEngine.js";
import {
  previewAnalysisProposal,
  applyAnalysisProposal,
  generateAnalysisProposal,
} from "../services/aiAnalysisProposalService.js";
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";

import {
  executeFinancialAnalysis,
  isFinancialAnalysisDataset,
} from "../services/analysisFinancialDatasets.js";
import { executeAnalysisPivot } from "../services/analysisPivotService.js";
import {
  applyAnalysisWorkbench,
  applyAnalysisScenarioModel,
  applyAnalysisFormulaModel,
  evaluateAnalysisExtension,
} from "../services/analysisWorkbenchService.js";

const router = Router();

function inputError(_res, error) {
  if (error.status && error.status !== 400)
    throw new AppError(error.message, {
      status: error.status,
      code: error.code || "INVALID_ANALYSIS_REQUEST",
    });
  throw new ValidationError(error.message, {
    code: error.code || "INVALID_ANALYSIS_REQUEST",
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
    const result =
      req.body.mode === "visual" &&
      isFinancialAnalysisDataset(req.body.plan.datasetId)
        ? await executeFinancialAnalysis(req.body.plan, {
            requestId: req.body.requestId,
            limit: req.body.limit,
            offset: req.body.offset,
          })
        : await executeAnalysisSql({
            requestId: req.body.requestId,
            sql: source.sql,
            values: source.values,
            datasetIds: source.datasetIds,
            limit: req.body.limit ?? source.visualPlan?.limit,
            offset: req.body.offset,
          });
    const prepared = applyAnalysisWorkbench(
      applyAnalysisScenarioModel(
        {
          ...result,
          generatedSql: source.sql,
          declaredColumns: result.declaredColumns || source.columns,
        },
        req.body.scenarioModel,
      ),
      req.body.workbench,
    );
    res.ok(
      req.body.formulaModel
        ? applyAnalysisFormulaModel(prepared, req.body.formulaModel)
        : prepared,
    );
  } catch (error) {
    const status = error.code === "57014" ? 408 : 400;
    const location = error.position ? ` (SQL character ${error.position})` : "";
    throw new AppError(`${error.message}${location}`, {
      status,
      code:
        error.code === "57014"
          ? "ANALYSIS_CANCELLED_OR_TIMED_OUT"
          : "ANALYSIS_EXECUTION_REJECTED",
    });
  }
});

router.post("/pivot", async (req, res) => {
  try {
    const catalog = getAnalysisCatalog().datasets.find(
      (d) => d.id === req.body.plan?.datasetId,
    );
    if (!catalog) throw new Error("Unsupported pivot dataset");
    res.ok(await executeAnalysisPivot(req.body, { catalog }));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/extensions/evaluate", (req, res) => {
  try {
    res.ok(evaluateAnalysisExtension(req.body));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/cancel/:requestId", async (req, res) => {
  try {
    res.ok(await cancelAnalysisQuery(req.params.requestId));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/formulas/evaluate", (req, res) => {
  try {
    res.ok(evaluateAnalysisFormulas(req.body || {}));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/ai-proposals/preview", async (req, res) => {
  try {
    res.ok(await previewAnalysisProposal(req.body));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/ai-proposals/apply", async (req, res) => {
  try {
    res.ok(await applyAnalysisProposal(req.body));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/saved/:id/ai-proposal", async (req, res) => {
  try {
    res.ok(
      await generateAnalysisProposal({
        savedAnalysisId: req.params.id,
        instruction: req.body.instruction,
        model: req.body.model,
      }),
    );
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
    const primaryKey =
      {
        transactions: "transaction_id",
        accounts: "account_id",
        holdings: "event_id",
        "cash-flows": "cash_flow_id",
      }[dataset.id] || dataset.fields[0].id;
    const groups = req.body.plan.groups || [];
    const filters = [
      ...(req.body.plan.filters || []),
      ...groups.map((fieldId) => ({
        fieldId,
        operator: req.body.row?.[fieldId] == null ? "is-null" : "eq",
        ...(req.body.row?.[fieldId] == null
          ? {}
          : { value: req.body.row[fieldId] }),
      })),
    ];
    const fields = [
      primaryKey,
      ...dataset.fields
        .map((field) => field.id)
        .filter((id) => id !== primaryKey)
        .slice(0, 7),
    ];
    const drillPlan = {
      ...req.body.plan,
      datasetId: dataset.id,
      fields,
      filters,
      groups: [],
      measures: [],
      orderBy: [{ id: primaryKey, direction: "asc" }],
      limit: 100,
    };
    const compiled = compileVisualAnalysis(drillPlan);
    const result = isFinancialAnalysisDataset(dataset.id)
      ? await executeFinancialAnalysis(drillPlan, {
          requestId: req.body.requestId,
          limit: 100,
        })
      : await executeAnalysisSql({
          requestId: req.body.requestId,
          sql: compiled.sql,
          values: compiled.values,
          datasetIds: compiled.datasetIds,
          limit: 100,
        });
    res.ok({
      ...result,
      generatedSql: compiled.sql,
      declaredColumns: result.declaredColumns || compiled.columns,
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
  if (!saved) throw new NotFoundError("Saved analysis not found");
  res.ok(saved);
});
router.get("/saved/:id/versions", async (req, res) => {
  const items = await listSavedAnalysisVersions(req.params.id);
  res.ok({ items, total: items.length });
});
router.post("/saved/:id/restore", async (req, res) => {
  try {
    res.ok(
      await restoreSavedAnalysisVersion(
        req.params.id,
        req.body.version,
        req.body.expectedVersion,
      ),
    );
  } catch (error) {
    inputError(res, error);
  }
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
    throw new NotFoundError("Saved analysis not found");
  res.status(204).end();
});

export default router;
