import {
  aiAnswerSchema,
  aiInvestigationPlanSchema,
  aiInvestigationRequestSchema,
  aiInvestigationScopeSchema,
} from "@vision/types/aiResearch";
import { dispatchTool } from "./aiChat/tools/index.js";
import {
  generateWithProvider,
  generateLocalSynthesis,
} from "./aiProviderAdapters.js";
import * as jobs from "../repositories/aiInvestigationRepository.js";
import {
  executeCloudAnalysisPlan,
  parseCloudAnalysisPlans,
} from "./cloudAnalysisPlan.js";
import {
  claimedReferenceExpiry,
  restoreAnswerForJob,
  validateReferenceRequest,
} from "./aiReferenceService.js";

const active = new Map();
let executionTail = Promise.resolve();

function planInvestigation(request) {
  if (request.route === "openai-api" && request.selectedEvidence)
    return aiInvestigationPlanSchema.parse({
      schemaVersion: 1,
      resolvedScope: request.scope,
      assumptions: [
        "Only the explicitly selected evidence is available to cloud synthesis.",
        "Vision did not retrieve or disclose additional private records for this mode.",
      ],
      ambiguity: { material: false, question: null },
      steps: [
        {
          id: "selected-evidence",
          tool: "useSelectedEvidence",
          args: {},
          purpose: "Use the exact evidence approved in the disclosure preview",
          dependsOn: [],
          canRunInParallel: false,
        },
      ],
      answerDepth: request.depth,
      language: request.language,
    });
  const steps = [];
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
      ])
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
  if (!steps.length)
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
  const assumptions = [];
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

function applyPlannerOrdering(text, baseline, provider, request) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed.stepIds)) return baseline;
    const byId = new Map(baseline.steps.map((step) => [step.id, step]));
    const selected = [];
    const seen = new Set();
    for (const id of parsed.stepIds) {
      if (typeof id !== "string" || seen.has(id) || !byId.has(id)) continue;
      selected.push(byId.get(id));
      seen.add(id);
    }
    for (const step of baseline.steps) {
      if (!seen.has(step.id)) selected.push(step);
    }
    const analysisPlans =
      request.route === "openai-api"
        ? parseCloudAnalysisPlans(text, {
            workspaces: request.scope.workspaces,
          })
        : [];
    const analysisSteps = analysisPlans.map((analysisPlan, index) => ({
      id: `cloud-analysis-${index + 1}`,
      tool: "executeCatalogAnalysis",
      args: { analysisPlan },
      purpose:
        "Execute a cloud-authored typed catalog plan inside Vision's local restricted analysis boundary",
      dependsOn: [],
      canRunInParallel: false,
    }));
    return aiInvestigationPlanSchema.parse({
      ...baseline,
      assumptions: [
        ...baseline.assumptions,
        `Step priority was proposed by ${provider} and constrained to the locally generated candidate plan.`,
      ],
      steps: [...selected, ...analysisSteps].slice(0, 24),
    });
  } catch {
    return baseline;
  }
}

const LOCALLY_RETRYABLE_TOOLS = new Set([
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

function shouldReuseStep(existing, step, skipAttemptedExternal) {
  return (
    existing?.state === "completed" ||
    (skipAttemptedExternal &&
      Number(existing?.attempt || 0) > 0 &&
      NON_REPLAYABLE_EXTERNAL_TOOLS.has(step.tool))
  );
}

function buildRetryPlan(plan, stepRows, selectedStepIds) {
  const failed = new Set(
    stepRows
      .filter((step) => step.state === "failed")
      .map((step) => step.stepId),
  );
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const retries = [];
  const seen = new Set();
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
  if (!retries.length || plan.steps.length + retries.length > 24) return plan;
  return aiInvestigationPlanSchema.parse({
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Detailed mode inspected failed local steps and scheduled one bounded retry pass.",
    ],
    steps: [...plan.steps, ...retries],
  });
}

function selectedStepIds(text) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed.stepIds)
      ? parsed.stepIds.filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function usesCloudSynthesis(request) {
  return request.route === "openai-api" && Boolean(request.selectedEvidence);
}

async function executeSteps({
  id,
  steps,
  request,
  controller,
  researchBudget,
  skipAttemptedExternal = false,
}) {
  for (const step of steps) {
    const currentJob = await jobs.getJob(id);
    if (currentJob.cancelRequestedAt)
      return jobs.finishJob(id, "cancelled", null, { code: "CANCELLED" });
    const existing = (await jobs.getSteps(id)).find(
      (item) => item.stepId === step.id,
    );
    if (shouldReuseStep(existing, step, skipAttemptedExternal)) continue;
    await jobs.startStep(id, step.id);
    try {
      if (step.tool === "useSelectedEvidence") {
        await jobs.finishStep(id, step.id, {
          ok: true,
          data: { text: request.selectedEvidence },
          meta: { source: "user-selected", disclosed: true },
        });
        continue;
      }
      if (step.tool === "executeCatalogAnalysis") {
        const data = await executeCloudAnalysisPlan(
          step.args.analysisPlan,
          request.scope,
          { requestId: `${id}-${step.id}`.slice(0, 128) },
        );
        await jobs.finishStep(id, step.id, {
          ok: true,
          data,
          meta: {
            source: "vision-local-analysis-executor",
            private: true,
            disclosed: false,
          },
        });
        continue;
      }
      let args = step.args;
      if (step.tool === "fetchPublicResearchPage") {
        const dependency = (await jobs.getSteps(id)).find(
          (item) => item.stepId === step.args.urlFromStep,
        );
        args = {
          url: dependency?.result?.data?.[step.args.resultIndex]?.url,
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
        dispatched.result.ok === false ? dispatched.result.error : null,
      );
    } catch (error) {
      await jobs.finishStep(id, step.id, null, {
        code: error.code || "STEP_FAILED",
        message: error.message,
      });
    }
  }
  return null;
}

function evidenceFromSteps(steps) {
  return steps.flatMap((step) => {
    if (step.state !== "completed") return [];
    const result = step.result;
    if (step.stepId === "selected-evidence" && result?.data?.text)
      return [
        {
          id: "selected-evidence",
          kind: "calculation",
          label: "Explicitly selected cloud evidence",
          sourceDate: null,
          locator: "cloud-disclosure:selected-evidence",
          excerpt: String(result.data.text).slice(0, 2000),
          available: true,
        },
      ];
    if (step.stepId === "documents" && Array.isArray(result?.data))
      return result.data.map((passage) => ({
        id: passage.id,
        kind: "document",
        label: `${passage.title} (version ${passage.documentVersion})`.slice(
          0,
          300,
        ),
        sourceDate: null,
        locator: [
          passage.sourceName,
          passage.pageNumber ? `page ${passage.pageNumber}` : null,
          passage.section ? `section ${passage.section}` : null,
          `passage ${passage.passageOrdinal}`,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 1000),
        excerpt: passage.text,
        available: true,
      }));
    if (step.stepId === "web" && Array.isArray(result?.data))
      return result.data.map((item, index) => ({
        id: `web:${index}:${item.url}`.slice(0, 160),
        kind: "web",
        label: String(item.title).slice(0, 300),
        sourceDate:
          String(item.publishedAt || result.meta?.fetchedAt || "").slice(
            0,
            40,
          ) || null,
        locator: String(item.url).slice(0, 1000),
        excerpt: item.snippet,
        available: true,
      }));
    if (step.stepId.startsWith("web-page-") && result?.data)
      return [
        {
          id: `page:${result.data.url}`.slice(0, 160),
          kind: "web",
          label: String(result.data.title).slice(0, 300),
          sourceDate: String(result.data.fetchedAt || "").slice(0, 40) || null,
          locator: String(result.data.url).slice(0, 1000),
          excerpt: String(result.data.text || "").slice(0, 2000),
          available: true,
        },
      ];
    if (step.stepId === "saved-analysis" && result?.data)
      return [
        {
          id: `analysis:${result.data.id}:v${result.data.version}`,
          kind: "analysis",
          label: `${result.data.name} (version ${result.data.version})`,
          sourceDate: null,
          locator: `/analysis?savedAnalysis=${result.data.id}`,
          excerpt: JSON.stringify(result.data.definition).slice(0, 2000),
          available: true,
        },
      ];
    return [
      {
        id: `tool:${step.stepId}`,
        kind: "research-service",
        label: step.stepId,
        sourceDate: result?.meta?.fetchedAt
          ? String(result.meta.fetchedAt).slice(0, 40)
          : null,
        locator: `investigation-step:${step.stepId}`,
        excerpt: JSON.stringify(result).slice(0, 2000),
        available: true,
      },
    ];
  });
}

function analysisReferenceFromSteps(steps) {
  const data = steps.find(
    (step) => step.stepId === "saved-analysis" && step.state === "completed",
  )?.result?.data;
  return data ? { id: data.id, version: Number(data.version) } : null;
}

function fallbackAnswer(request, steps, error = null) {
  const evidence = evidenceFromSteps(steps);
  const dutch = request.language === "nl";
  return aiAnswerSchema.parse({
    schemaVersion: 1,
    status: evidence.length ? "partial" : "abstained",
    depth: request.depth,
    language: request.language,
    summary: evidence.length
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
      error?.message ||
        (dutch
          ? "Een geldig gestructureerd modelantwoord is niet beschikbaar."
          : "A valid structured model response is unavailable."),
    ],
    conflicts: [],
    evidence,
    analysisReference: analysisReferenceFromSteps(steps),
  });
}

function parseModelAnswer(text, request, steps) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const value = JSON.parse(text.slice(start, end + 1));
    value.evidence = evidenceFromSteps(steps);
    value.analysisReference = analysisReferenceFromSteps(steps);
    return aiAnswerSchema.parse(value);
  } catch (error) {
    return fallbackAnswer(request, steps, error);
  }
}

function shouldPreserveProviderCheckpoint(job) {
  return (
    job.state === "failed" &&
    typeof job.error?.code === "string" &&
    job.error.code.startsWith("REFERENCE_")
  );
}

async function resolveProviderAnswer({
  job,
  request,
  stepRows,
  synthesisInput,
  generateProvider = generateWithProvider,
  generateLocal = generateLocalSynthesis,
  store = jobs.setProviderResult,
}) {
  if (job?.checkpoint?.providerResult)
    return aiAnswerSchema.parse(job.checkpoint.providerResult);
  const response = usesCloudSynthesis(request)
    ? await generateProvider(synthesisInput)
    : await generateLocal(synthesisInput);
  const answer = parseModelAnswer(response.text, request, stepRows);
  await store(job.id, answer);
  return answer;
}

export async function runInvestigationJob(
  id,
  { skipAttemptedExternal = false } = {},
) {
  if (active.has(id)) return active.get(id).promise;
  const controller = new AbortController();
  const task = executionTail
    .catch(() => {})
    .then(async () => {
      let job = await jobs.getJob(id);
      if (!job) throw new Error("Investigation job not found");
      if (job.state === "completed" || job.state === "cancelled") return job;
      const stored = job.scope?.scope
        ? job.scope
        : {
            scope: job.scope,
            researchMode: "local-only",
            publicQuestion: null,
            publicWebQuery: null,
            publicSymbols: [],
            publicMacroQueries: [],
            clarification: null,
            selectedSummary: null,
            selectedEvidence: null,
            referenceScopeId: null,
            savedAnalysisId: null,
          };
      const request = aiInvestigationRequestSchema.parse({
        question: job.question,
        route: job.route,
        model: job.model,
        depth: job.depth,
        language: job.language,
        scope: stored.scope,
        researchMode: stored.researchMode,
        publicQuestion: stored.publicQuestion ?? null,
        publicWebQuery: stored.publicWebQuery ?? null,
        publicSymbols: stored.publicSymbols ?? [],
        publicMacroQueries: stored.publicMacroQueries ?? [],
        clarification: stored.clarification ?? null,
        grantId: job.grantId,
        selectedSummary: stored.selectedSummary ?? null,
        selectedEvidence: stored.selectedEvidence ?? null,
        referenceScopeId: stored.referenceScopeId ?? null,
        savedAnalysisId: stored.savedAnalysisId ?? null,
      });
      let plan = job.plan;
      if (!plan) {
        const baseline = planInvestigation(request);
        if (baseline.ambiguity.material) {
          return jobs.setWaiting(id, baseline);
        }
        if (
          (request.route === "local" && request.depth === "quick") ||
          usesCloudSynthesis(request)
        ) {
          plan = aiInvestigationPlanSchema.parse({
            ...baseline,
            assumptions: [
              ...baseline.assumptions,
              request.selectedEvidence
                ? "Selected-evidence mode skipped cloud planning so the approved payload is sent only for final synthesis."
                : "Quick mode used the deterministic bounded plan to avoid an extra local model pass.",
            ],
          });
        } else
          try {
            const planning = await generateWithProvider({
              jobId: id,
              request,
              signal: controller.signal,
              messages: [
                {
                  role: "system",
                  content:
                    "Return JSON only as {stepIds:string[],analysisPlans:CloudAnalysisPlan[]}. Prioritize supplied candidate step ids and optionally propose typed catalog plans that match the supplied public schema. Do not answer the question, emit SQL, or invent tools.",
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
              request,
            );
          } catch (error) {
            plan = aiInvestigationPlanSchema.parse({
              ...baseline,
              assumptions: [
                ...baseline.assumptions,
                `Model planning was unavailable (${error.code || "PLANNER_FAILED"}); Vision used the inspectable bounded plan.`,
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
          .reduce((count, step) => count + Number(step.attempt || 0), 0),
        pages: priorSteps
          .filter((step) => step.stepId.startsWith("web-page-"))
          .reduce((count, step) => count + Number(step.attempt || 0), 0),
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
          if (candidates.length) {
            const inspection = await generateLocalSynthesis({
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
          jobId: id,
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
        const providerAnswer = await resolveProviderAnswer({
          job: await jobs.getJob(id),
          request,
          stepRows,
          synthesisInput,
        });
        let answer;
        try {
          answer = await restoreAnswerForJob(id, providerAnswer);
        } catch (restoreError) {
          return jobs.finishJob(
            id,
            "failed",
            fallbackAnswer(request, [], restoreError),
            {
              code: restoreError.code || "REFERENCE_RESTORE_FAILED",
              message:
                "The cloud response could not be safely restored from local references.",
            },
          );
        }
        return jobs.finishJob(
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
        return jobs.finishJob(
          id,
          stepRows.some((step) => step.state === "completed")
            ? "partial"
            : "failed",
          fallbackAnswer(request, stepRows, error),
          { code: error.code || "SYNTHESIS_FAILED", message: error.message },
        );
      }
    })
    .finally(() => active.delete(id));
  active.set(id, { promise: task, controller });
  executionTail = task;
  return task;
}

export async function createInvestigation(input) {
  const request = aiInvestigationRequestSchema.parse(input);
  await validateReferenceRequest(request);
  const job = await jobs.createJob(
    request,
    request.referenceScopeId ? claimedReferenceExpiry() : null,
  );
  void runInvestigationJob(job.id);
  return job;
}
export const listInvestigations = jobs.listJobs;
export async function getInvestigation(id) {
  const job = await jobs.getJob(id);
  if (!job) return null;
  return { ...job, steps: await jobs.getSteps(id) };
}
export async function cancelInvestigation(id) {
  active.get(id)?.controller.abort();
  return jobs.requestCancel(id);
}
export async function deleteInvestigation(id) {
  const running = active.get(id);
  if (running) {
    running.controller.abort();
    await jobs.requestCancel(id);
    await running.promise.catch(() => {});
  }
  return jobs.deleteJob(id);
}
export async function resumeInvestigation(
  id,
  clarification = null,
  scope = null,
) {
  let job = await jobs.getJob(id);
  if (!job) return null;
  if (job.state === "waiting") {
    if (!clarification)
      throw Object.assign(new Error("A clarification is required"), {
        status: 400,
        code: "CLARIFICATION_REQUIRED",
      });
    const resolvedScope = /** @type {any} */ (
      aiInvestigationScopeSchema.parse(scope ?? job.scope?.scope)
    );
    if (!resolvedScope.dateFrom || !resolvedScope.dateTo)
      throw Object.assign(
        new Error(
          "A complete typed date range is required to resolve this comparison",
        ),
        { status: 400, code: "COMPARISON_SCOPE_REQUIRED" },
      );
    job = await jobs.resolveWaiting(id, clarification, resolvedScope);
  } else if (scope) {
    const suppliedScope = /** @type {any} */ (
      aiInvestigationScopeSchema.parse(scope)
    );
    const storedScope = /** @type {any} */ (
      aiInvestigationScopeSchema.parse(job.scope?.scope)
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
    if (!shouldPreserveProviderCheckpoint(job)) {
      const refreshIds = job.plan.steps
        .filter((step) => LOCALLY_RETRYABLE_TOOLS.has(step.tool))
        .map((step) => step.id);
      await jobs.resetSteps(id, refreshIds);
      await jobs.clearProviderResult(id);
    }
  }
  void runInvestigationJob(id, { skipAttemptedExternal: true });
  return job;
}

export async function resumeRecoverableInvestigations({
  list = jobs.listRecoverableJobs,
  run = runInvestigationJob,
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
  usesCloudSynthesis as __usesCloudSynthesis,
  applyPlannerOrdering as __applyPlannerOrdering,
  resolveProviderAnswer as __resolveProviderAnswer,
  shouldPreserveProviderCheckpoint as __shouldPreserveProviderCheckpoint,
};
