/** Restricted analysis catalog, execution, drill-through, and persistence API. */

import { Router } from "express";
import { z } from "zod";
import type { ExpressResponse } from "../types/express.ts";
import { ANALYSIS_WORKSPACES } from "@vision/types/analysis";
import { aiAnalysisEditProposalSchema } from "@vision/types/aiResearch";
import {
  getAnalysisCatalog,
  compileVisualAnalysis,
} from "../services/analysisCatalog.ts";
import {
  executeAnalysisSql,
  cancelAnalysisQuery,
} from "../services/analysisExecutor.ts";
import {
  listSavedAnalyses,
  getSavedAnalysis,
  createSavedAnalysis,
  updateSavedAnalysis,
  runSavedAnalysis,
  deleteSavedAnalysis,
  listSavedAnalysisVersions,
  restoreSavedAnalysisVersion,
} from "../services/savedAnalysisService.ts";
import type {
  SavedAnalysisInput,
  SavedAnalysisUpdate,
} from "../services/savedAnalysisService.ts";
import { evaluateAnalysisFormulas } from "../services/analysisFormulaEngine.ts";
import type { EvaluateAnalysisFormulasInput } from "../services/analysisFormulaEngine.ts";
import {
  previewAnalysisProposal,
  applyAnalysisProposal,
  generateAnalysisProposal,
} from "../services/aiAnalysisProposalService.ts";
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import { nullAsAbsent, parseInput } from "../lib/zodInput.ts";

import {
  executeFinancialAnalysis,
  isFinancialAnalysisDataset,
} from "../services/analysisFinancialDatasets.ts";
import { executeAnalysisPivot } from "../services/analysisPivotService.ts";
import {
  applyAnalysisWorkbench,
  applyAnalysisScenarioModel,
  applyAnalysisFormulaModel,
  evaluateAnalysisExtension,
} from "../services/analysisWorkbenchService.ts";
import type {
  AnalysisExtensionRequest,
  AnalysisFormulaModel,
  AnalysisWorkbench,
} from "../services/analysisWorkbenchService.ts";
import type { AnalysisColumn } from "../services/analysisExtensions.ts";

const router = Router();

// ── Request schemas ───────────────────────────────────────────────────────────
// These pin the request envelope: every field a handler reads has a checked
// type. Payloads the analysis services interpret (workbench steps, formulas,
// assumptions, scenario inputs, saved definitions) are checked as containers
// here; the catalog, executor and engines own their semantic validation and
// soft per-formula errors.

const jsonObjectSchema = z.record(z.string(), z.unknown());
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const stringListSchema = z.array(z.string());

const visualFilterSchema = z.object({
  fieldId: z.string(),
  operator: z.string(),
  value: scalarSchema.optional(),
});

/** Unknown keys are kept: the compiler echoes the plan back as `visualPlan`. */
const visualPlanSchema = z.looseObject({
  datasetId: z.string(),
  fields: stringListSchema.optional(),
  groups: stringListSchema.optional(),
  measures: stringListSchema.optional(),
  joins: stringListSchema.optional(),
  filters: z.array(visualFilterSchema).optional(),
  orderBy: z
    .array(z.object({ id: z.string(), direction: z.enum(["asc", "desc"]) }))
    .optional(),
  // The compiler treats null like absent (`plan.limit || 500`); a saved
  // plan edited by an AI proposal can carry null here.
  limit: nullAsAbsent(z.number()),
  reportingCurrency: nullAsAbsent(z.string()),
  from: nullAsAbsent(z.string()),
  to: nullAsAbsent(z.string()),
  symbol: nullAsAbsent(z.string()),
  range: nullAsAbsent(z.string()),
  costBasisMethod: nullAsAbsent(z.string()),
  generatedSql: z.string().optional(),
});

const columnSchema = z.looseObject({ id: z.string() });

const workbenchSchema = z.looseObject({
  steps: z.array(jsonObjectSchema).optional(),
  time: jsonObjectSchema.optional(),
});

const formulaModelSchema = z.looseObject({
  formulas: z.array(jsonObjectSchema).optional(),
  assumptions: z.array(jsonObjectSchema).optional(),
  assumptionValues: jsonObjectSchema.optional(),
});

const scenarioModelSchema = z.looseObject({
  attachments: z.array(z.unknown()).optional(),
  joins: z.array(z.unknown()).optional(),
});

const executeOptionsShape = {
  requestId: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  workbench: workbenchSchema.optional(),
  scenarioModel: scenarioModelSchema.nullish(),
  formulaModel: formulaModelSchema.nullish(),
};

// An omitted mode runs custom SQL.
const executeBodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("visual"),
    plan: visualPlanSchema,
    ...executeOptionsShape,
  }),
  z.object({
    mode: z.literal("sql").optional(),
    sql: z.string(),
    values: z.array(scalarSchema).optional(),
    datasetIds: stringListSchema.optional(),
    columns: z
      .array(
        columnSchema.extend({ label: z.string().optional(), type: z.string() }),
      )
      .optional(),
    ...executeOptionsShape,
  }),
]);

const pivotBodySchema = z.object({
  plan: visualPlanSchema,
  config: z
    .object({
      rows: stringListSchema.optional(),
      columns: stringListSchema.optional(),
      values: stringListSchema.optional(),
      filters: z.array(visualFilterSchema).optional(),
    })
    .optional(),
  requestId: z.string().optional(),
});

const rowsSchema = z.array(jsonObjectSchema);
const decimalInputSchema = z.union([z.string(), z.number()]);

const extensionBodySchema = z.looseObject({
  operation: z.enum([
    "prepare",
    "time",
    "scenarios",
    "sensitivity",
    "goal",
    "formulas",
  ]),
  rows: rowsSchema,
  columns: z.array(columnSchema).optional(),
  complete: z.boolean().optional(),
  inputComplete: z.boolean().optional(),
  window: jsonObjectSchema.optional(),
  coverage: jsonObjectSchema.optional(),
  workbench: workbenchSchema.optional(),
  formulas: z.array(jsonObjectSchema).optional(),
  assumptions: jsonObjectSchema.optional(),
  assumptionUnits: jsonObjectSchema.optional(),
  dateColumn: z.string().optional(),
  valueColumns: stringListSchema.optional(),
  outcomeId: z.string().optional(),
  variableId: z.string().optional(),
  target: decimalInputSchema.optional(),
  lower: decimalInputSchema.optional(),
  upper: decimalInputSchema.optional(),
});

const formulaBodySchema = z.looseObject({
  rows: rowsSchema,
  formulas: z.array(jsonObjectSchema).optional(),
  assumptions: jsonObjectSchema.optional(),
  inputComplete: z.boolean().optional(),
  columns: z.array(columnSchema).optional(),
  assumptionUnits: jsonObjectSchema.optional(),
});

const ANALYSIS_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const cancelParamsSchema = z.object({
  requestId: z.string().regex(ANALYSIS_REQUEST_ID),
});

const drillBodySchema = z.object({
  plan: visualPlanSchema,
  row: jsonObjectSchema.optional(),
  requestId: z.string().optional(),
});

const savedIdParamsSchema = z.object({ id: z.string().min(1) });

const savedListQuerySchema = z.object({
  workspace: z.enum(ANALYSIS_WORKSPACES).or(z.literal("")).optional(),
});

const querySpecSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("visual"), plan: visualPlanSchema }),
  z.object({
    mode: z.literal("sql"),
    sql: z.string(),
    datasetIds: stringListSchema,
    columns: z.array(columnSchema).optional(),
    visualOrigin: visualPlanSchema.optional(),
  }),
]);

const savedAnalysisFieldsShape = {
  querySpec: querySpecSchema,
  parameters: jsonObjectSchema.optional(),
  charts: z.array(z.unknown()).optional(),
  sourceReferences: z.array(z.unknown()).optional(),
  refreshMode: z.enum(["live", "frozen"]).optional(),
  formulas: z.array(jsonObjectSchema).optional(),
  assumptions: z.array(jsonObjectSchema).optional(),
  assumptionValues: jsonObjectSchema.optional(),
};

const createSavedBodySchema = z.object({
  name: z.string(),
  workspace: z.enum(ANALYSIS_WORKSPACES),
  ...savedAnalysisFieldsShape,
});

const updateSavedBodySchema = z.object({
  name: z.string().optional(),
  workspace: z.enum(ANALYSIS_WORKSPACES).optional(),
  expectedVersion: z.union([z.int().positive(), z.string()]).nullish(),
  ...savedAnalysisFieldsShape,
});

const restoreBodySchema = z.object({
  version: z.int().positive(),
  expectedVersion: z.int().positive(),
});

const AI_INSTRUCTION_LENGTH =
  "AI edit instruction must contain 1 to 2000 characters";
const aiProposalBodySchema = z.object({
  instruction: z
    .string()
    .trim()
    .min(1, AI_INSTRUCTION_LENGTH)
    .max(2000, AI_INSTRUCTION_LENGTH),
  model: z.string().nullish(),
});

// ── Error mapping ─────────────────────────────────────────────────────────────

/**
 * Analysis services throw plain Errors decorated with optional `status`,
 * `code` (including PostgreSQL SQLSTATE) and `position` fields.
 */
interface AnalysisFailure {
  message: string;
  status?: number;
  code?: string;
  position?: unknown;
}

function analysisFailure(error: unknown): AnalysisFailure {
  const fields: Record<string, unknown> =
    typeof error === "object" && error !== null ? { ...error } : {};
  return {
    message: error instanceof Error ? error.message : String(error),
    status: typeof fields.status === "number" ? fields.status : undefined,
    code: typeof fields.code === "string" ? fields.code : undefined,
    position: fields.position,
  };
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
// SQLSTATE classes for a lost connection, exhausted resources, operator
// intervention (57P*, not 57014 query_canceled), system and internal errors.
const SERVER_FAULT_SQLSTATE = /^(?:08|53|57P|58|XX)[0-9A-Z]+$/;

/** A database or network outage is a server fault, not a rejected analysis. */
function isServerFault(error: AnalysisFailure): boolean {
  if (error.status !== undefined || error.code === undefined) return false;
  return (
    NETWORK_ERROR_CODES.has(error.code) ||
    (error.code.length === 5 && SERVER_FAULT_SQLSTATE.test(error.code))
  );
}

function inputError(_res: ExpressResponse, caught: unknown): never {
  const error = analysisFailure(caught);
  if (isServerFault(error)) throw caught;
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
  const plan = parseInput(visualPlanSchema, req.body);
  try {
    const compiled = compileVisualAnalysis(plan);
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
  const body = parseInput(executeBodySchema, req.body);
  try {
    const source: {
      sql: string;
      values: unknown[];
      datasetIds: string[];
      columns: AnalysisColumn[];
      visualPlan?: { limit?: number };
    } =
      body.mode === "visual"
        ? compileVisualAnalysis(body.plan)
        : {
            sql: body.sql,
            values: body.values ?? [],
            datasetIds: body.datasetIds ?? [],
            columns: body.columns ?? [],
          };
    const result =
      body.mode === "visual" && isFinancialAnalysisDataset(body.plan.datasetId)
        ? await executeFinancialAnalysis(body.plan, {
            requestId: body.requestId,
            limit: body.limit,
            offset: body.offset,
          })
        : await executeAnalysisSql({
            requestId: body.requestId,
            sql: source.sql,
            values: source.values,
            datasetIds: source.datasetIds,
            limit: body.limit ?? source.visualPlan?.limit,
            offset: body.offset,
          });
    const prepared = applyAnalysisWorkbench(
      applyAnalysisScenarioModel(
        {
          ...result,
          generatedSql: source.sql,
          declaredColumns:
            ("declaredColumns" in result && result.declaredColumns) ||
            source.columns,
        },
        body.scenarioModel,
      ),
      // Step and comparison shapes are validated by the extension engine.
      body.workbench as AnalysisWorkbench | undefined,
    );
    res.ok(
      body.formulaModel
        ? applyAnalysisFormulaModel(
            prepared,
            // The formula engine validates formulas and assumption values.
            body.formulaModel as AnalysisFormulaModel,
          )
        : prepared,
    );
  } catch (caught) {
    const error = analysisFailure(caught);
    if (isServerFault(error)) throw caught;
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
  const body = parseInput(pivotBodySchema, req.body);
  try {
    const catalog = getAnalysisCatalog().datasets.find(
      (d) => d.id === body.plan.datasetId,
    );
    if (!catalog) throw new Error("Unsupported pivot dataset");
    res.ok(await executeAnalysisPivot(body, { catalog }));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/extensions/evaluate", (req, res) => {
  const body = parseInput(extensionBodySchema, req.body);
  try {
    // Each operation validates its own parameters and row limits.
    res.ok(evaluateAnalysisExtension(body as AnalysisExtensionRequest));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/cancel/:requestId", async (req, res) => {
  const { requestId } = parseInput(cancelParamsSchema, req.params);
  try {
    res.ok(await cancelAnalysisQuery(requestId));
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/formulas/evaluate", (req, res) => {
  const body = parseInput(formulaBodySchema, req.body);
  try {
    // The engine validates formula identity, scope and limits.
    res.ok(evaluateAnalysisFormulas(body as EvaluateAnalysisFormulasInput));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/ai-proposals/preview", async (req, res) => {
  const proposal = parseInput(aiAnalysisEditProposalSchema, req.body);
  try {
    res.ok(await previewAnalysisProposal(proposal));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/ai-proposals/apply", async (req, res) => {
  const proposal = parseInput(aiAnalysisEditProposalSchema, req.body);
  try {
    res.ok(await applyAnalysisProposal(proposal));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/saved/:id/ai-proposal", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  const { instruction, model } = parseInput(aiProposalBodySchema, req.body);
  try {
    res.ok(
      await generateAnalysisProposal({
        savedAnalysisId: id,
        instruction,
        model,
      }),
    );
  } catch (error) {
    inputError(res, error);
  }
});

router.post("/drill", async (req, res) => {
  const { plan, row, requestId } = parseInput(drillBodySchema, req.body);
  try {
    const catalog = getAnalysisCatalog();
    const dataset = catalog.datasets.find(
      (entry) => entry.id === plan.datasetId,
    );
    if (!dataset) throw new Error("Unknown drill-through dataset");
    const primaryKey =
      {
        transactions: "transaction_id",
        accounts: "account_id",
        holdings: "event_id",
        "cash-flows": "cash_flow_id",
      }[dataset.id] || dataset.fields[0].id;
    const groups = plan.groups || [];
    const filters = [
      ...(plan.filters || []),
      ...groups.map((fieldId) => ({
        fieldId,
        operator: row?.[fieldId] == null ? "is-null" : "eq",
        ...(row?.[fieldId] == null ? {} : { value: row[fieldId] }),
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
      ...plan,
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
          requestId,
          limit: 100,
        })
      : await executeAnalysisSql({
          requestId,
          sql: compiled.sql,
          values: compiled.values,
          datasetIds: compiled.datasetIds,
          limit: 100,
        });
    res.ok({
      ...result,
      generatedSql: compiled.sql,
      declaredColumns:
        ("declaredColumns" in result && result.declaredColumns) ||
        compiled.columns,
    });
  } catch (error) {
    inputError(res, error);
  }
});

router.get("/saved", async (req, res) => {
  const { workspace } = parseInput(savedListQuerySchema, req.query);
  try {
    const items = await listSavedAnalyses(workspace || undefined);
    res.ok({ items, total: items.length });
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/saved", async (req, res) => {
  const input = parseInput(createSavedBodySchema, req.body);
  try {
    res.status(201);
    // buildDefinition validates formulas and assumptions with the contract schema.
    res.ok(await createSavedAnalysis(input as SavedAnalysisInput));
  } catch (error) {
    inputError(res, error);
  }
});
router.get("/saved/:id", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  const saved = await getSavedAnalysis(id);
  if (!saved) throw new NotFoundError("Saved analysis not found");
  res.ok(saved);
});
router.get("/saved/:id/versions", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  const items = await listSavedAnalysisVersions(id);
  res.ok({ items, total: items.length });
});
router.post("/saved/:id/restore", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  const { version, expectedVersion } = parseInput(restoreBodySchema, req.body);
  try {
    res.ok(await restoreSavedAnalysisVersion(id, version, expectedVersion));
  } catch (error) {
    inputError(res, error);
  }
});
router.put("/saved/:id", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  const input = parseInput(updateSavedBodySchema, req.body);
  try {
    // buildDefinition validates formulas and assumptions with the contract schema.
    res.ok(await updateSavedAnalysis(id, input as SavedAnalysisUpdate));
  } catch (error) {
    inputError(res, error);
  }
});
router.post("/saved/:id/run", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  try {
    res.ok(await runSavedAnalysis(id));
  } catch (error) {
    inputError(res, error);
  }
});
router.delete("/saved/:id", async (req, res) => {
  const { id } = parseInput(savedIdParamsSchema, req.params);
  if (!(await deleteSavedAnalysis(id)))
    throw new NotFoundError("Saved analysis not found");
  res.status(204).end();
});

export default router;
