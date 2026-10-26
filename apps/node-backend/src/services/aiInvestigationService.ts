import {
  aiAnswerSchema,
  aiInvestigationPlanSchema,
  aiInvestigationRequestSchema,
  aiInvestigationScopeSchema,
} from "@vision/types/aiResearch";
import type {
  AiAnswer,
  AiEvidenceReference,
  AiInvestigationPlan,
  AiInvestigationRequest,
  AiPlanStep,
} from "@vision/types/aiResearch";
import { dispatchTool } from "./aiChat/tools/index.ts";
import { generateLocal } from "./aiProviderAdapters.ts";
import type { ProviderGenerationInput } from "./aiProviderAdapters.ts";
import * as jobs from "../repositories/aiInvestigationRepository.ts";
import type {
  AiInvestigationJobRow,
  AiInvestigationStepRow,
} from "../repositories/aiInvestigationRepository.ts";
import type { ResearchDocumentCitation } from "./aiResearchDocuments.ts";
import type { PublicWebSearchResult } from "./webResearch.ts";
import { nanToZero } from "../lib/math.ts";
import { valueText } from "./valueText.ts";
import { isUnknownArray } from "../lib/typeGuards.ts";

type InvestigationOutcome = AiInvestigationJobRow | null | undefined;

const active = new Map<
  string,
  { promise: Promise<InvestigationOutcome>; controller: AbortController }
>();
let executionTail: Promise<unknown> = Promise.resolve();

/**
 * `value?.[key]` for a stored JSON value of unknown shape: `undefined` for
 * null/undefined, otherwise the property as JavaScript reads it (primitives
 * are boxed, exactly like optional chaining does).
 */
function field(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  return (Object(value) as Record<string, unknown>)[key];
}

/** Reads `error?.[key]` from a caught value without assuming its shape. */
function errorProperty(error: unknown, key: "code" | "message"): unknown {
  return typeof error === "object" && error !== null
    ? Reflect.get(error, key)
    : undefined;
}

/**
 * The `stepIds` array of the JSON object embedded in a model reply, or null
 * when absent. Throws when the embedded text is not valid JSON.
 */
function parseStepIds(text: string): unknown[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) return null;
  const stepIds: unknown = Reflect.get(parsed, "stepIds");
  return isUnknownArray(stepIds) ? stepIds : null;
}

function planInvestigation(
  request: AiInvestigationRequest,
): AiInvestigationPlan {
  const steps: AiPlanStep[] = [];
  if (request.savedAnalysisId)
    steps.push({
      id: "saved-analysis",
      tool: "getSavedAnalysisContext",
      args: { id: request.savedAnalysisId },
      purpose: "Preserve the current saved analysis scope and version",
      dependsOn: [],
      canRunInParallel: false,
    });
  const includesBudgeting =
    request.scope.workspaces.includes("budgeting") ||
    request.scope.workspaces.includes("cross-workspace");
  const includesPortfolio =
    request.scope.workspaces.includes("portfolio") ||
    request.scope.workspaces.includes("cross-workspace");
  if (includesBudgeting && request.scope.dateFrom && request.scope.dateTo)
    steps.push({
      id: "cashflow-range",
      tool: "getNetCashflow",
      args: { from: request.scope.dateFrom, to: request.scope.dateTo },
      purpose: "Calculate canonical cash flow for the selected date range",
      dependsOn: [],
      canRunInParallel: true,
    });
  else if (includesBudgeting)
    steps.push({
      id: "balances",
      tool: "getBankBalances",
      args: {},
      purpose: "Establish current account balances",
      dependsOn: [],
      canRunInParallel: true,
    });
  if (includesPortfolio)
    steps.push({
      id: "holdings",
      tool: "getPortfolioHoldings",
      args: {},
      purpose: "Establish current portfolio holdings",
      dependsOn: [],
      canRunInParallel: true,
    });
  if (includesPortfolio && request.scope.dateFrom && request.scope.dateTo)
    steps.push({
      id: "portfolio-income-range",
      tool: "getReturnsForRange",
      args: { from: request.scope.dateFrom, to: request.scope.dateTo },
      purpose:
        "Retrieve canonical portfolio income for the selected date range",
      dependsOn: [],
      canRunInParallel: true,
    });
  if (
    request.scope.workspaces.includes("research") ||
    request.scope.workspaces.includes("cross-workspace")
  )
    steps.push({
      id: "documents",
      tool: "searchLocalResearchDocuments",
      args: {
        query: request.question,
        mode: "hybrid",
        limit: request.depth === "detailed" ? 12 : 6,
      },
      purpose: "Retrieve cited local research passages",
      dependsOn: [],
      canRunInParallel: true,
    });
  if (request.researchMode === "public-web") {
    steps.push({
      id: "web",
      tool: "searchPublicResearchWeb",
      args: {
        query: request.publicWebQuery,
        count: request.depth === "detailed" ? 5 : 3,
      },
      purpose: "Find current public sources",
      dependsOn: [],
      canRunInParallel: true,
    });
    const pageCount = request.depth === "detailed" ? 2 : 1;
    for (let index = 0; index < pageCount; index += 1)
      steps.push({
        id: `web-page-${index + 1}`,
        tool: "fetchPublicResearchPage",
        args: { urlFromStep: "web", resultIndex: index },
        purpose: "Retrieve bounded text from a selected public search result",
        dependsOn: ["web"],
        canRunInParallel: false,
      });
  }
  if (request.researchMode === "public-providers") {
    for (const rawSymbol of request.publicSymbols) {
      const symbol = rawSymbol.toUpperCase();
      for (const [suffix, tool, purpose] of [
        ["quote", "getResearchQuote", "Retrieve a dated public market quote"],
        [
          "fundamentals",
          "getResearchFundamentals",
          "Retrieve bounded public fundamentals",
        ],
        ["news", "getResearchNews", "Retrieve bounded public market news"],
      ] as const)
        steps.push({
          id: `${suffix}-${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          tool,
          args: { symbol },
          purpose,
          dependsOn: [],
          canRunInParallel: true,
        });
    }
    request.publicMacroQueries.forEach((query, index) =>
      steps.push({
        id: `macro-search-${index + 1}`,
        tool: "searchMacroResearch",
        args: { query },
        purpose: "Search the bounded public macroeconomic catalog",
        dependsOn: [],
        canRunInParallel: true,
      }),
    );
  }
  if (steps.length === 0)
    steps.push({
      id: "context",
      tool: "getCategories",
      args: {},
      purpose: "Establish the available analysis context",
      dependsOn: [],
      canRunInParallel: true,
    });
  const needsComparisonPeriod =
    /\b(compare|comparison|versus|vs\.?|vergelijk)\b/i.test(request.question) &&
    !request.scope.dateFrom &&
    !request.scope.dateTo &&
    !request.clarification;
  const assumptions: string[] = [];
  if (request.scope.accountIds.length === 0)
    assumptions.push("All accounts in the selected workspaces are in scope.");
  if (request.clarification)
    assumptions.push(`User clarification: ${request.clarification}`);
  return aiInvestigationPlanSchema.parse({
    schemaVersion: 1,
    resolvedScope: request.scope,
    assumptions,
    ambiguity: {
      material: needsComparisonPeriod,
      question: needsComparisonPeriod
        ? "Which comparison periods should Vision use?"
        : null,
    },
    steps,
    answerDepth: request.depth,
    language: request.language,
  });
}

function applyPlannerOrdering(
  text: string,
  baseline: AiInvestigationPlan,
  provider: string,
): AiInvestigationPlan {
  try {
    const stepIds = parseStepIds(text);
    if (!stepIds) return baseline;
    const byId = new Map(baseline.steps.map((step) => [step.id, step]));
    const selected: AiPlanStep[] = [];
    const seen = new Set<string>();
    for (const id of stepIds) {
      if (typeof id !== "string" || seen.has(id)) continue;
      const step = byId.get(id);
      if (!step) continue;
      selected.push(step);
      seen.add(id);
    }
    for (const step of baseline.steps) {
      if (!seen.has(step.id)) selected.push(step);
    }
    return aiInvestigationPlanSchema.parse({
      ...baseline,
      assumptions: [
        ...baseline.assumptions,
        `Step priority was proposed by ${provider} and constrained to the locally generated candidate plan.`,
      ],
      steps: selected.slice(0, 24),
    });
  } catch {
    return baseline;
  }
}

const LOCALLY_RETRYABLE_TOOLS = new Set<string | undefined>([
  "getSavedAnalysisContext",
  "getBankBalances",
  "getPortfolioHoldings",
  "getNetCashflow",
  "getReturnsForRange",
  "searchLocalResearchDocuments",
  "getCategories",
]);
const NON_REPLAYABLE_EXTERNAL_TOOLS = new Set([
  "searchPublicResearchWeb",
  "fetchPublicResearchPage",
  "getResearchQuote",
  "getResearchFundamentals",
  "getResearchNews",
  "searchMacroResearch",
]);

function shouldReuseStep(
  existing: AiInvestigationStepRow | undefined,
  step: AiPlanStep,
  skipAttemptedExternal: boolean,
) {
  return (
    existing?.state === "completed" ||
    (skipAttemptedExternal &&
      (existing?.attempt ?? 0) > 0 &&
      NON_REPLAYABLE_EXTERNAL_TOOLS.has(step.tool))
  );
}

function buildRetryPlan(
  plan: AiInvestigationPlan,
  stepRows: AiInvestigationStepRow[],
  selectedStepIds: string[],
): AiInvestigationPlan {
  const failed = new Set(
    stepRows
      .filter((step) => step.state === "failed")
      .map((step) => step.stepId),
  );
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const retries: AiPlanStep[] = [];
  const seen = new Set<string>();
  for (const id of selectedStepIds) {
    const original = byId.get(id);
    if (
      retries.length >= 3 ||
      !failed.has(id) ||
      seen.has(id) ||
      !original ||
      !LOCALLY_RETRYABLE_TOOLS.has(original.tool)
    )
      continue;
    seen.add(id);
    retries.push({
      ...original,
      id: `retry-${original.id}`.slice(0, 64),
      purpose:
        `Retry after inspecting the partial result: ${original.purpose}`.slice(
          0,
          500,
        ),
      dependsOn: [original.id],
      canRunInParallel: false,
    });
  }
  if (retries.length === 0 || plan.steps.length + retries.length > 24)
    return plan;
  return aiInvestigationPlanSchema.parse({
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Detailed mode inspected failed local steps and scheduled one bounded retry pass.",
    ],
    steps: [...plan.steps, ...retries],
  });
}

function selectedStepIds(text: string): string[] {
  try {
    const stepIds = parseStepIds(text);
    return stepIds
      ? stepIds.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

async function executeSteps({
  id,
  steps,
  request,
  controller,
  researchBudget,
  skipAttemptedExternal = false,
}: {
  id: string;
  steps: AiPlanStep[];
  request: AiInvestigationRequest;
  controller: AbortController;
  researchBudget: { searches: number; pages: number };
  skipAttemptedExternal?: boolean;
}): Promise<InvestigationOutcome> {
  for (const step of steps) {
    const currentJob = await jobs.getJob(id);
    if (!currentJob) throw new Error("Investigation job not found");
    if (currentJob.cancelRequestedAt)
      return jobs.finishJob(id, "cancelled", null, { code: "CANCELLED" });
    const existing = (await jobs.getSteps(id)).find(
      (item) => item.stepId === step.id,
    );
    if (shouldReuseStep(existing, step, skipAttemptedExternal)) continue;
    await jobs.startStep(id, step.id);
    try {
      let args = step.args;
      if (step.tool === "fetchPublicResearchPage") {
        const dependency = (await jobs.getSteps(id)).find(
          (item) => item.stepId === step.args.urlFromStep,
        );
        args = {
          // String() is the property key JS derives from the index anyway.
          url: field(
            field(
              field(dependency?.result, "data"),
              String(step.args.resultIndex),
            ),
            "url",
          ),
        };
      }
      const dispatched = await dispatchTool(step.tool, args, {
        maxRows: 500,
        cache: new Map(),
        allowExternalResearch: request.researchMode !== "local-only",
        allowWebResearch: request.researchMode === "public-web",
        researchBudget,
        allowSavedAnalysis: true,
        signal: controller.signal,
        scope: request.scope,
      });
      await jobs.finishStep(
        id,
        step.id,
        dispatched.result,
        !dispatched.result.ok ? dispatched.result.error : null,
      );
    } catch (error) {
      await jobs.finishStep(id, step.id, null, {
        code: errorProperty(error, "code") || "STEP_FAILED",
        message: errorProperty(error, "message"),
      });
    }
  }
  return null;
}

function evidenceFromSteps(
  steps: AiInvestigationStepRow[],
): AiEvidenceReference[] {
  return steps.flatMap((step): AiEvidenceReference[] => {
    if (step.state !== "completed") return [];
    const result = step.result;
    const data = field(result, "data");
    // The documents and web steps store the tool's own result arrays.
    if (step.stepId === "documents" && Array.isArray(data))
      return (data as ResearchDocumentCitation[]).map((passage) => ({
        id: passage.id,
        kind: "document",
        label: `${passage.title} (version ${passage.documentVersion})`.slice(
          0,
          300,
        ),
        sourceDate: null,
        locator: [
          passage.sourceName,
          passage.pageNumber != null && passage.pageNumber !== 0
            ? `page ${passage.pageNumber}`
            : null,
          passage.section ? `section ${passage.section}` : null,
          `passage ${passage.passageOrdinal}`,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 1000),
        excerpt: passage.text,
        available: true,
      }));
    if (step.stepId === "web" && Array.isArray(data))
      return (data as PublicWebSearchResult[]).map((item, index) => ({
        id: `web:${index}:${item.url}`.slice(0, 160),
        kind: "web",
        label: valueText(item.title).slice(0, 300),
        sourceDate:
          valueText(
            item.publishedAt || field(field(result, "meta"), "fetchedAt") || "",
          ).slice(0, 40) || null,
        locator: valueText(item.url).slice(0, 1000),
        excerpt: item.snippet,
        available: true,
      }));
    if (step.stepId.startsWith("web-page-") && data)
      return [
        {
          id: `page:${valueText(field(data, "url"))}`.slice(0, 160),
          kind: "web",
          label: valueText(field(data, "title")).slice(0, 300),
          sourceDate:
            valueText(field(data, "fetchedAt") || "").slice(0, 40) || null,
          locator: valueText(field(data, "url")).slice(0, 1000),
          excerpt: valueText(field(data, "text") || "").slice(0, 2000),
          available: true,
        },
      ];
    if (step.stepId === "saved-analysis" && data)
      return [
        {
          id: `analysis:${valueText(field(data, "id"))}:v${valueText(field(data, "version"))}`,
          kind: "analysis",
          label: `${valueText(field(data, "name"))} (version ${valueText(field(data, "version"))})`,
          sourceDate: null,
          locator: `/analysis?savedAnalysis=${valueText(field(data, "id"))}`,
          excerpt: JSON.stringify(field(data, "definition")).slice(0, 2000),
          available: true,
        },
      ];
    const fetchedAt = field(field(result, "meta"), "fetchedAt");
    return [
      {
        id: `tool:${step.stepId}`,
        kind: "research-service",
        label: step.stepId,
        sourceDate: fetchedAt ? valueText(fetchedAt).slice(0, 40) : null,
        locator: `investigation-step:${step.stepId}`,
        excerpt: JSON.stringify(result).slice(0, 2000),
        available: true,
      },
    ];
  });
}

function analysisReferenceFromSteps(
  steps: AiInvestigationStepRow[],
): { id: string; version: number } | null {
  const data = field(
    steps.find(
      (step) => step.stepId === "saved-analysis" && step.state === "completed",
    )?.result,
    "data",
  );
  // The saved-analysis tool stores `{ id, version, ... }`; aiAnswerSchema
  // re-validates the reference when the answer is parsed.
  return data
    ? {
        id: field(data, "id") as string,
        version: Number(field(data, "version")),
      }
    : null;
}

function fallbackAnswer(
  request: Pick<AiInvestigationRequest, "depth" | "language">,
  steps: AiInvestigationStepRow[],
  error: unknown = null,
): AiAnswer {
  const evidence = evidenceFromSteps(steps);
  const dutch = request.language === "nl";
  return aiAnswerSchema.parse({
    schemaVersion: 1,
    status: evidence.length > 0 ? "partial" : "abstained",
    depth: request.depth,
    language: request.language,
    summary:
      evidence.length > 0
        ? dutch
          ? "Er is bewijs verzameld, maar het gekozen model gaf geen geldige gestructureerde synthese terug."
          : "Evidence was collected, but the selected model did not return a valid structured synthesis."
        : dutch
          ? "Er is onvoldoende geverifieerd bewijs om deze vraag te beantwoorden."
          : "There is not enough verified evidence to answer this question.",
    facts: [],
    calculations: [],
    interpretations: [],
    assumptions: [],
    missingInformation: [
      errorProperty(error, "message") ||
        (dutch
          ? "Een geldig gestructureerd modelantwoord is niet beschikbaar."
          : "A valid structured model response is unavailable."),
    ],
    conflicts: [],
    evidence,
    analysisReference: analysisReferenceFromSteps(steps),
  });
}

function parseModelAnswer(
  text: string,
  request: Pick<AiInvestigationRequest, "depth" | "language">,
  steps: AiInvestigationStepRow[],
): AiAnswer {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof value === "object" && value !== null) {
      Object.assign(value, {
        evidence: evidenceFromSteps(steps),
        analysisReference: analysisReferenceFromSteps(steps),
      });
    }
    return aiAnswerSchema.parse(value);
  } catch (error) {
    return fallbackAnswer(request, steps, error);
  }
}

async function resolveProviderAnswer({
  job,
  request,
  stepRows,
  synthesisInput,
  generate = generateLocal,
  store = jobs.setProviderResult,
}: {
  job: AiInvestigationJobRow | null;
  request: AiInvestigationRequest;
  stepRows: AiInvestigationStepRow[];
  synthesisInput: ProviderGenerationInput;
  generate?: typeof generateLocal;
  store?: (id: string, result: unknown) => Promise<unknown>;
}): Promise<AiAnswer> {
  if (job?.checkpoint.providerResult)
    return aiAnswerSchema.parse(job.checkpoint.providerResult);
  const response = await generate(synthesisInput);
  if (synthesisInput.signal?.aborted)
    throw Object.assign(new Error("Investigation was cancelled"), {
      code: "CANCELLED",
    });
  const answer = parseModelAnswer(response.text, request, stepRows);
  if (!job) throw new Error("Investigation job not found");
  if (!(await store(job.id, answer)))
    throw Object.assign(new Error("Investigation was cancelled"), {
      code: "CANCELLED",
    });
  return answer;
}

export async function runInvestigationJob(
  id: string,
  { skipAttemptedExternal = false }: { skipAttemptedExternal?: boolean } = {},
): Promise<InvestigationOutcome> {
  const running = active.get(id);
  if (running) return running.promise;
  const controller = new AbortController();
  const task = executionTail
    .catch(() => {})
    .then(async (): Promise<InvestigationOutcome> => {
      let job = await jobs.getJob(id);
      if (!job) throw new Error("Investigation job not found");
      if (job.state === "completed" || job.state === "cancelled") return job;
      const envelope = job.scope;
      const stored: Record<string, unknown> = field(envelope, "scope")
        ? (envelope as Record<string, unknown>)
        : {
            scope: job.scope,
            researchMode: "local-only",
            publicWebQuery: null,
            publicSymbols: [],
            publicMacroQueries: [],
            clarification: null,
            savedAnalysisId: null,
          };
      const request = aiInvestigationRequestSchema.parse({
        question: job.question,
        model: job.model,
        depth: job.depth,
        language: job.language,
        scope: stored.scope,
        researchMode: stored.researchMode,
        publicWebQuery: stored.publicWebQuery ?? null,
        publicSymbols: stored.publicSymbols ?? [],
        publicMacroQueries: stored.publicMacroQueries ?? [],
        clarification: stored.clarification ?? null,
        savedAnalysisId: stored.savedAnalysisId ?? null,
      });
      let plan: AiInvestigationPlan;
      if (job.plan) plan = job.plan;
      else {
        const baseline = planInvestigation(request);
        if (baseline.ambiguity.material) {
          return jobs.setWaiting(id, baseline);
        }
        if (request.depth === "quick") {
          plan = aiInvestigationPlanSchema.parse({
            ...baseline,
            assumptions: [
              ...baseline.assumptions,
              "Quick mode used the deterministic bounded plan to avoid an extra local model pass.",
            ],
          });
        } else
          try {
            const planning = await generateLocal({
              request,
              signal: controller.signal,
              messages: [
                {
                  role: "system",
                  content:
                    "Return JSON only as {stepIds:string[]}. Prioritize supplied candidate step ids. Do not answer the question, emit SQL, or invent tools.",
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    question: request.question,
                    candidates: baseline.steps.map((step) => ({
                      id: step.id,
                      purpose: step.purpose,
                      dependsOn: step.dependsOn,
                    })),
                  }),
                },
              ],
            });
            plan = applyPlannerOrdering(
              planning.text,
              baseline,
              planning.provider,
            );
          } catch (error) {
            plan = aiInvestigationPlanSchema.parse({
              ...baseline,
              assumptions: [
                ...baseline.assumptions,
                `Model planning was unavailable (${valueText(errorProperty(error, "code") || "PLANNER_FAILED")}); Vision used the inspectable bounded plan.`,
              ],
            });
          }
      }
      job = await jobs.setPlan(id, plan);
      if (!job) return jobs.getJob(id);
      await jobs.seedSteps(id, plan.steps);
      const priorSteps = await jobs.getSteps(id);
      const researchBudget = {
        searches: priorSteps
          .filter((step) => step.stepId === "web")
          .reduce((count, step) => count + nanToZero(step.attempt), 0),
        pages: priorSteps
          .filter((step) => step.stepId.startsWith("web-page-"))
          .reduce((count, step) => count + nanToZero(step.attempt), 0),
      };
      const cancelled = await executeSteps({
        id,
        steps: plan.steps,
        request,
        controller,
        researchBudget,
        skipAttemptedExternal,
      });
      if (cancelled) return cancelled;
      let stepRows = await jobs.getSteps(id);
      if (
        request.depth === "detailed" &&
        stepRows.some((step) => step.state === "failed") &&
        !plan.steps.some((step) => step.id.startsWith("retry-"))
      ) {
        try {
          const candidates = stepRows
            .filter((step) => step.state === "failed")
            .filter((step) =>
              LOCALLY_RETRYABLE_TOOLS.has(
                plan.steps.find((item) => item.id === step.stepId)?.tool,
              ),
            )
            .map((step) => ({ id: step.stepId, error: step.error }));
          if (candidates.length > 0) {
            const inspection = await generateLocal({
              request,
              signal: controller.signal,
              messages: [
                {
                  role: "system",
                  content:
                    "Inspect the failed local evidence steps. Return JSON only as {stepIds:string[]} with at most three candidate ids worth retrying once. Do not answer the question and do not select external or web steps.",
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    question: request.question,
                    candidates,
                    collectedEvidence: evidenceFromSteps(stepRows).map(
                      (item) => ({ id: item.id, label: item.label }),
                    ),
                  }),
                },
              ],
            });
            const revised = buildRetryPlan(
              plan,
              stepRows,
              selectedStepIds(inspection.text),
            );
            if (revised !== plan) {
              const retrySteps = revised.steps.slice(plan.steps.length);
              plan = revised;
              await jobs.setPlan(id, plan);
              await jobs.seedSteps(id, retrySteps);
              const retryCancelled = await executeSteps({
                id,
                steps: retrySteps,
                request,
                controller,
                researchBudget,
                skipAttemptedExternal,
              });
              if (retryCancelled) return retryCancelled;
              stepRows = await jobs.getSteps(id);
            }
          }
        } catch {
          // A failed inspection pass does not discard already collected evidence.
        }
      }
      try {
        const synthesisInput = {
          request,
          signal: controller.signal,
          messages: [
            {
              role: "system",
              content:
                "Return only JSON matching Vision AI answer schema v1. Separate facts, calculations, interpretations, assumptions, missingInformation, conflicts, and evidenceIds. Cite only the supplied evidence ids. Use status complete, qualified, abstained, or partial.",
            },
            {
              role: "user",
              content: JSON.stringify({
                question: request.question,
                depth: request.depth,
                language: request.language,
                evidence: evidenceFromSteps(stepRows),
                failedSteps: stepRows
                  .filter((step) => step.state === "failed")
                  .map((step) => ({
                    id: step.stepId,
                    error: step.error,
                  })),
              }),
            },
          ],
        };
        const answer = await resolveProviderAnswer({
          job: await jobs.getJob(id),
          request,
          stepRows,
          synthesisInput,
        });
        return await jobs.finishJob(
          id,
          stepRows.some((step) => step.state === "failed") ||
            answer.status === "partial"
            ? "partial"
            : "completed",
          answer,
        );
      } catch (error) {
        if ((await jobs.getJob(id))?.cancelRequestedAt)
          return jobs.finishJob(id, "cancelled", null, { code: "CANCELLED" });
        return await jobs.finishJob(
          id,
          stepRows.some((step) => step.state === "completed")
            ? "partial"
            : "failed",
          fallbackAnswer(request, stepRows, error),
          {
            code: errorProperty(error, "code") || "SYNTHESIS_FAILED",
            message: errorProperty(error, "message"),
          },
        );
      }
    })
    .finally(() => active.delete(id));
  active.set(id, { promise: task, controller });
  executionTail = task;
  return task;
}

export async function createInvestigation(input: unknown) {
  const request = aiInvestigationRequestSchema.parse(input);
  const job = await jobs.createJob(request);
  void runInvestigationJob(job.id);
  return job;
}
export const listInvestigations = jobs.listJobs;
export async function getInvestigation(id: string) {
  const job = await jobs.getJob(id);
  if (!job) return null;
  return { ...job, steps: await jobs.getSteps(id) };
}
export async function cancelInvestigation(id: string) {
  active.get(id)?.controller.abort();
  return jobs.requestCancel(id);
}
export async function deleteInvestigation(id: string) {
  const running = active.get(id);
  if (running) {
    running.controller.abort();
    await jobs.requestCancel(id);
    await running.promise.catch(() => {});
  }
  return jobs.deleteJob(id);
}
export async function resumeInvestigation(
  id: string,
  clarification: string | null = null,
  scope: unknown = null,
) {
  let job = await jobs.getJob(id);
  if (!job) return null;
  if (job.state === "waiting") {
    if (!clarification)
      throw Object.assign(new Error("A clarification is required"), {
        status: 400,
        code: "CLARIFICATION_REQUIRED",
      });
    const resolvedScope = aiInvestigationScopeSchema.parse(
      scope ?? field(job.scope, "scope"),
    );
    if (!resolvedScope.dateFrom || !resolvedScope.dateTo)
      throw Object.assign(
        new Error(
          "A complete typed date range is required to resolve this comparison",
        ),
        { status: 400, code: "COMPARISON_SCOPE_REQUIRED" },
      );
    job = await jobs.resolveWaiting(id, clarification, resolvedScope);
    if (!job) throw new Error("Investigation job is no longer waiting");
  } else if (scope) {
    const suppliedScope = aiInvestigationScopeSchema.parse(scope);
    const storedScope = aiInvestigationScopeSchema.parse(
      field(job.scope, "scope"),
    );
    if (JSON.stringify(suppliedScope) !== JSON.stringify(storedScope))
      throw Object.assign(
        new Error("Changed scope requires a new investigation job"),
        { status: 409, code: "SCOPE_CHANGE_REQUIRES_NEW_JOB" },
      );
  }
  if (
    !["queued", "waiting", "partial", "failed", "running"].includes(job.state)
  )
    return job;
  if (["partial", "failed"].includes(job.state) && job.plan) {
    const refreshIds = job.plan.steps
      .filter((step) => LOCALLY_RETRYABLE_TOOLS.has(step.tool))
      .map((step) => step.id);
    await jobs.resetSteps(id, refreshIds);
    await jobs.clearProviderResult(id);
  }
  void runInvestigationJob(id, { skipAttemptedExternal: true });
  return job;
}

export async function resumeRecoverableInvestigations({
  list = jobs.listRecoverableJobs,
  run = runInvestigationJob,
}: {
  list?: () => Promise<Array<{ id: string }>>;
  run?: (id: string) => Promise<unknown>;
} = {}) {
  const recoverable = await list();
  for (const job of recoverable) void run(job.id);
  return recoverable.length;
}

export {
  planInvestigation as __planInvestigation,
  evidenceFromSteps as __evidenceFromSteps,
  fallbackAnswer as __fallbackAnswer,
  buildRetryPlan as __buildRetryPlan,
  shouldReuseStep as __shouldReuseStep,
  resolveProviderAnswer as __resolveProviderAnswer,
};
