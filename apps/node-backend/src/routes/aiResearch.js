import { Router } from "express";
import { z } from "zod";
import settings from "../config/config.js";
import { getOllamaClient } from "../integrations/ollama/client.js";
import {
  aiDisclosureGrantSchema,
  aiInvestigationRequestSchema,
  aiInvestigationScopeSchema,
} from "@vision/types/aiResearch";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.js";
import { disclosurePayload } from "../services/aiProviderAdapters.js";
import {
  createInvestigation,
  listInvestigations,
  getInvestigation,
  cancelInvestigation,
  deleteInvestigation,
  resumeInvestigation,
} from "../services/aiInvestigationService.js";
import {
  createDisclosureGrant,
  listDisclosureGrants,
  listDisclosureRecords,
  revokeDisclosureGrant,
  deleteDisclosureHistory,
} from "../services/aiDisclosureService.js";

const router = Router();
const uuid = z.string().uuid();
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  return result.data;
}
function id(req) {
  return parse(uuid, req.params.id);
}

router.get("/status", async (_req, res) => {
  let localModels = [];
  let localStatus;
  try {
    localModels = await getOllamaClient().listModels();
    localStatus = "available";
  } catch {
    localStatus = "unavailable";
  }
  res.ok({
    defaultRoute: "local",
    providers: [
      {
        id: "ollama",
        route: "local",
        status: localStatus,
        models: localModels,
        configuredContextTokens: settings.ollama.numCtx,
        supportsTools: true,
        supportsEmbeddings: Boolean(settings.ollama.embeddingModel),
      },
      {
        id: "openai-api",
        route: "openai-api",
        status: settings.aiResearch.openai.enabled ? "configured" : "disabled",
        models: settings.aiResearch.openai.model
          ? [{ name: settings.aiResearch.openai.model }]
          : [],
        supportsTools: false,
        supportsEmbeddings: false,
      },
    ],
    openai: {
      enabled: settings.aiResearch.openai.enabled,
      model: settings.aiResearch.openai.model || null,
      storageRequested: false,
      hostedToolsEnabled: false,
      disclosureModes: [
        {
          id: "cloud-plan-public",
          capability: "cloud-planning-local-synthesis",
          disclosedField: "publicQuestion",
        },
        {
          id: "selected-summary",
          capability: "cloud-planning-local-synthesis",
          disclosedField: "selectedSummary",
        },
        {
          id: "cloud-synthesis-selected",
          capability: "cloud-final-synthesis-without-tools",
          disclosedField: "selectedEvidence",
        },
      ],
      monthlyBudgetMicros: settings.aiResearch.openai.monthlyBudgetMicros,
    },
    web: {
      enabled: settings.aiResearch.web.enabled,
      searchLimitPerJob: settings.aiResearch.web.maxSearches,
      pageLimitPerJob: settings.aiResearch.web.maxPages,
    },
    localDocuments: {
      supportedMediaTypes: ["text/plain", "text/markdown", "text/html"],
      pdfSupported: false,
    },
    orchestration: {
      maxConcurrentJobs: 1,
      maxPlanSteps: 24,
      maxDetailedReplans: 1,
      maxLocalRetrySteps: 3,
      parallelToolExecution: false,
      resourcePolicy:
        "Jobs and tools are serialized to bound local CPU and memory use.",
    },
  });
});

router.post("/disclosures/preview", (req, res) => {
  const request = parse(aiInvestigationRequestSchema, req.body);
  if (request.route !== "openai-api")
    throw new ValidationError(
      "Preview is only needed for the OpenAI API route",
    );
  const preview = disclosurePayload(request);
  res.ok({
    payload: preview.payload,
    payloadSha256: preview.payloadSha256,
    payloadBytes: preview.payloadBytes,
    inputCharacters: preview.inputCharacters,
    fieldManifest: preview.fieldManifest,
    disclosureUnits: preview.disclosureUnits,
  });
});
router.post("/disclosures/grants", async (req, res) => {
  const grant = parse(aiDisclosureGrantSchema, req.body);
  res.status(201);
  res.ok(await createDisclosureGrant(grant));
});
router.get("/disclosures/grants", async (_req, res) => {
  const items = await listDisclosureGrants();
  res.ok({ items, total: items.length });
});
router.post("/disclosures/grants/:id/revoke", async (req, res) => {
  if (!(await revokeDisclosureGrant(id(req))))
    throw new NotFoundError("Disclosure grant not found");
  res.ok({ revoked: true });
});
router.get("/disclosures/records", async (_req, res) => {
  const items = await listDisclosureRecords();
  res.ok({ items, total: items.length });
});
router.delete("/disclosures/records", async (_req, res) =>
  res.ok({ deleted: await deleteDisclosureHistory() }),
);

router.get("/investigations", async (_req, res) => {
  const items = await listInvestigations();
  res.ok({ items, total: items.length });
});
router.post("/investigations", async (req, res) => {
  const request = parse(aiInvestigationRequestSchema, req.body);
  const job = await createInvestigation(request);
  res.status(202);
  res.ok(job);
});
router.get("/investigations/:id", async (req, res) => {
  const job = await getInvestigation(id(req));
  if (!job) throw new NotFoundError("Investigation not found");
  res.ok(job);
});
router.post("/investigations/:id/resume", async (req, res) => {
  const body = parse(
    z.strictObject({
      clarification: z.string().min(1).max(1000).optional(),
      scope: aiInvestigationScopeSchema.optional(),
    }),
    req.body || {},
  );
  const job = await resumeInvestigation(
    id(req),
    body.clarification,
    body.scope,
  );
  if (!job) throw new NotFoundError("Investigation not found");
  res.status(202);
  res.ok(job);
});
router.post("/investigations/:id/cancel", async (req, res) => {
  const job = await cancelInvestigation(id(req));
  if (!job) throw new NotFoundError("Investigation is not active");
  res.ok(job);
});
router.delete("/investigations/:id", async (req, res) => {
  if (!(await deleteInvestigation(id(req))))
    throw new NotFoundError("Investigation not found");
  res.status(204).end();
});

export default router;
