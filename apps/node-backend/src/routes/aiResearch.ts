import { Router } from "express";
import type { ExpressRequest } from "../types/express.ts";
import { z } from "zod";
import settings from "../config/config.ts";
import { getOllamaClient } from "../integrations/ollama/client.ts";
import type { OllamaModelSummary } from "../integrations/ollama/client.ts";
import {
  aiDisclosureGrantSchema,
  aiInvestigationRequestSchema,
  aiInvestigationScopeSchema,
} from "@vision/types/aiResearch";
import {
  ValidationError,
  NotFoundError,
  UpstreamError,
} from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import { disclosurePayload } from "../services/aiProviderAdapters.ts";
import {
  checkAgentCloakPreflight,
  detectAgentCloakDesktopSpans,
} from "../services/agentCloakPreflight.ts";
import { getAgentCloakConfig } from "../services/agentCloakRuntimeConfig.ts";
import {
  agentCloakDesktopStatus,
  configureAgentCloakDesktop,
} from "../services/agentCloakDesktopSetupService.ts";
import {
  createInvestigation,
  listInvestigations,
  getInvestigation,
  cancelInvestigation,
  deleteInvestigation,
  resumeInvestigation,
} from "../services/aiInvestigationService.ts";
import {
  createDisclosureGrant,
  listDisclosureGrants,
  listDisclosureRecords,
  revokeDisclosureGrant,
  deleteDisclosureHistory,
} from "../services/aiDisclosureService.ts";
import {
  mappingKey,
  prepareReferencePreview,
  validateReferenceRequest,
} from "../services/aiReferenceService.ts";

const router = Router();
const uuid = z.string().uuid();
const desktopPreferenceSchema = z.strictObject({ enabled: z.boolean() });
const resumeInvestigationSchema = z.strictObject({
  clarification: z.string().min(1).max(1000).optional(),
  scope: aiInvestigationScopeSchema.optional(),
});
function id(req: ExpressRequest): string {
  return parseInput(uuid, req.params.id);
}
/** AgentCloak service errors carry a string `code`; anything else has none. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

router.get("/agentcloak-desktop", async (_req, res) => {
  res.ok(await agentCloakDesktopStatus());
});

router.put("/agentcloak-desktop", async (req, res) => {
  const { enabled } = parseInput(desktopPreferenceSchema, req.body);
  res.ok(await configureAgentCloakDesktop(enabled));
});

router.get("/status", async (_req, res) => {
  const agentCloakConfig = await getAgentCloakConfig();
  let localModels: OllamaModelSummary[] = [];
  let localStatus;
  try {
    localModels = await getOllamaClient().listModels();
    localStatus = "available";
  } catch {
    localStatus = "unavailable";
  }
  const selectableOpenAiModels = settings.aiResearch.openai.models.filter(
    (model) =>
      model.inputMicrosPerMillion > 0 && model.outputMicrosPerMillion > 0,
  );
  const defaultOpenAiModel = selectableOpenAiModels.some(
    (model) => model.id === settings.aiResearch.openai.model,
  )
    ? settings.aiResearch.openai.model
    : null;
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
        status:
          settings.aiResearch.openai.enabled && selectableOpenAiModels.length
            ? "configured"
            : "disabled",
        models: selectableOpenAiModels.map((model) => ({
          name: model.id,
          label: model.label,
        })),
        supportsTools: false,
        supportsEmbeddings: false,
      },
    ],
    openai: {
      enabled: settings.aiResearch.openai.enabled,
      model: defaultOpenAiModel,
      models: selectableOpenAiModels.map((model) => ({
        id: model.id,
        label: model.label,
        inputMicrosPerMillion: model.inputMicrosPerMillion,
        outputMicrosPerMillion: model.outputMicrosPerMillion,
        isDefault: model.id === defaultOpenAiModel,
      })),
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
      reversibleReferences: {
        configured: Boolean(mappingKey()),
        markerSyntax: "[[vision-ref:type|value]]",
        classification: "pseudonymized-not-anonymous",
      },
      agentCloakPreflight: {
        enabled: Boolean(agentCloakConfig.enabled),
        mode:
          agentCloakConfig.mode === "desktop"
            ? "protect-and-block"
            : "block-on-change",
        location:
          agentCloakConfig.mode === "desktop"
            ? "desktop-loopback"
            : "operator-managed-loopback",
      },
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

router.post("/disclosures/preview", async (req, res) => {
  const request = parseInput(aiInvestigationRequestSchema, req.body);
  if (request.route !== "openai-api")
    throw new ValidationError(
      "Preview is only needed for the OpenAI API route",
    );
  const agentCloakConfig = await getAgentCloakConfig();
  let prepared;
  try {
    prepared = await prepareReferencePreview(request, {
      detectSensitiveSpans:
        agentCloakConfig.enabled && agentCloakConfig.mode === "desktop"
          ? (text) =>
              detectAgentCloakDesktopSpans(text, { config: agentCloakConfig })
          : undefined,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code?.startsWith("AGENTCLOAK_"))
      throw new UpstreamError("AgentCloak Desktop is unavailable", { code });
    throw error;
  }
  await validateReferenceRequest(prepared.request);
  const preview = disclosurePayload(prepared.request);
  let agentCloakPreflight;
  try {
    agentCloakPreflight = await checkAgentCloakPreflight(
      preview.disclosedPayload,
      { config: agentCloakConfig },
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "AGENTCLOAK_SENSITIVE_TEXT")
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
        { code },
      );
    throw new UpstreamError("AgentCloak preflight is unavailable", {
      code: code || "AGENTCLOAK_PREFLIGHT_FAILED",
    });
  }
  res.ok({
    payload: preview.payload,
    payloadSha256: preview.payloadSha256,
    payloadBytes: preview.payloadBytes,
    inputCharacters: preview.inputCharacters,
    fieldManifest: preview.fieldManifest,
    disclosureUnits: preview.disclosureUnits,
    referenceScope: prepared.scope,
    outboundRequest: prepared.request,
    agentCloakPreflight,
  });
});
router.post("/disclosures/grants", async (req, res) => {
  const grant = parseInput(aiDisclosureGrantSchema, req.body);
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
