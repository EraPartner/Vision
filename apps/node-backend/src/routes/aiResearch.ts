import { Router } from "express";
import type { ExpressRequest } from "../types/express.ts";
import { z } from "zod";
import settings from "../config/config.ts";
import { getOllamaClient } from "../integrations/ollama/client.ts";
import type { OllamaModelSummary } from "../integrations/ollama/client.ts";
import {
  aiInvestigationRequestSchema,
  aiInvestigationScopeSchema,
} from "@vision/types/aiResearch";
import { NotFoundError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import {
  createInvestigation,
  listInvestigations,
  getInvestigation,
  cancelInvestigation,
  deleteInvestigation,
  resumeInvestigation,
} from "../services/aiInvestigationService.ts";
const router = Router();
const uuid = z.string().uuid();
const resumeInvestigationSchema = z.strictObject({
  clarification: z.string().min(1).max(1000).optional(),
  scope: aiInvestigationScopeSchema.optional(),
});
function id(req: ExpressRequest): string {
  return parseInput(uuid, req.params.id);
}
router.get("/status", async (_req, res) => {
  let localModels: OllamaModelSummary[] = [];
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
    ],
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

router.get("/investigations", async (_req, res) => {
  const items = await listInvestigations();
  res.ok({ items, total: items.length });
});
router.post("/investigations", async (req, res) => {
  const request = parseInput(aiInvestigationRequestSchema, req.body);
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
  const body = parseInput(resumeInvestigationSchema, req.body ?? {});
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
