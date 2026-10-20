import { describe, expect, it, vi } from "vitest";
import {
  __evidenceFromSteps,
  __fallbackAnswer,
  __buildRetryPlan,
  __planInvestigation,
  __shouldReuseStep,
  __resolveProviderAnswer,
  resumeRecoverableInvestigations,
} from "../src/services/aiInvestigationService.ts";
import type {
  AiInvestigationRequest,
  AiPlanStep,
} from "@vision/types/aiResearch";
import type {
  AiInvestigationJobRow,
  AiInvestigationStepRow,
} from "../src/repositories/aiInvestigationRepository.ts";
import type {
  ProviderGeneration,
  ProviderGenerationInput,
} from "../src/services/aiProviderAdapters.ts";
import { partial } from "./helpers/partial.ts";

const request = partial<AiInvestigationRequest>({
  question: "Exclude rent and compare last year",
  route: "local",
  researchMode: "local-only",
  model: null,
  depth: "detailed",
  language: "en",
  savedAnalysisId: "c6700b7c-6cc5-42a7-9af2-b9cd992ea3de",
  scope: {
    workspaces: ["research"],
    accountIds: [],
    investmentIds: [],
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    currency: "EUR",
    constraints: ["Keep the existing transfer filter"],
  },
});

describe("AI investigation orchestration", () => {
  it("preserves an explicitly selected analysis and adds only relevant tools", () => {
    const plan = __planInvestigation(request);
    expect(plan.resolvedScope).toEqual(request.scope);
    expect(plan.steps.map((step) => step.tool)).toEqual([
      "getSavedAnalysisContext",
      "searchLocalResearchDocuments",
    ]);
  });

  it("uses only explicitly public inputs for external research", () => {
    const providerPlan = __planInvestigation({
      ...request,
      researchMode: "public-providers",
      publicSymbols: ["VWCE"],
      publicMacroQueries: [],
    });
    expect(providerPlan.steps.map((step) => step.tool)).toEqual([
      "getSavedAnalysisContext",
      "searchLocalResearchDocuments",
      "getResearchQuote",
      "getResearchFundamentals",
      "getResearchNews",
    ]);
    const webPlan = __planInvestigation({
      ...request,
      question: "My private portfolio concern",
      researchMode: "public-web",
      publicWebQuery: "Belgian inflation outlook 2026",
      publicSymbols: [],
      publicMacroQueries: [],
    });
    expect(webPlan.steps.find((step) => step.id === "web")?.args.query).toBe(
      "Belgian inflation outlook 2026",
    );
  });

  it("pauses a materially ambiguous comparison plan", () => {
    const plan = __planInvestigation({
      ...request,
      scope: { ...request.scope, dateFrom: null, dateTo: null },
      clarification: null,
    });
    expect(plan.ambiguity).toEqual({
      material: true,
      question: "Which comparison periods should Vision use?",
    });
  });

  it("turns retrieved passages into directly selectable evidence references", () => {
    const evidence = __evidenceFromSteps(
      partial<AiInvestigationStepRow[]>([
        {
          stepId: "documents",
          state: "completed",
          result: {
            data: [
              {
                id: "document:doc:v2:p3",
                title: "Annual report",
                sourceName: "annual.md",
                documentVersion: 2,
                passageOrdinal: 3,
                pageNumber: null,
                section: "Risk",
                text: "Demand declined during the quarter.",
              },
            ],
          },
        },
      ]),
    );
    expect(evidence[0]).toMatchObject({
      id: "document:doc:v2:p3",
      kind: "document",
      locator: "annual.md · section Risk · passage 3",
      excerpt: "Demand declined during the quarter.",
    });
  });

  it("localizes an abstention when no valid synthesis is available", () => {
    const answer = __fallbackAnswer({ ...request, language: "nl" }, []);
    expect(answer.status).toBe("abstained");
    expect(answer.language).toBe("nl");
    expect(answer.summary).toContain("onvoldoende geverifieerd bewijs");
  });

  it("queues unfinished durable jobs again after startup", async () => {
    const resumed: string[] = [];
    const count = await resumeRecoverableInvestigations({
      list: async () => [{ id: "oldest" }, { id: "newest" }],
      run: async (id) => resumed.push(id),
    });
    expect(count).toBe(2);
    expect(resumed).toEqual(["oldest", "newest"]);
  });

  it("restores a checkpointed provider-form answer after restart without another model call", async () => {
    const checkpointed = __fallbackAnswer(request, []);
    const generate = vi.fn();
    const store = vi.fn();
    const resolved = await __resolveProviderAnswer({
      job: partial<AiInvestigationJobRow>({
        id: "job-1",
        checkpoint: { providerResult: checkpointed },
      }),
      request,
      stepRows: [],
      synthesisInput: partial<ProviderGenerationInput>({}),
      generate,
      store,
    });
    expect(resolved).toEqual(checkpointed);
    expect(generate).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("does not checkpoint a provider answer after the investigation was cancelled", async () => {
    const controller = new AbortController();
    const store = vi.fn();
    await expect(
      __resolveProviderAnswer({
        job: partial<AiInvestigationJobRow>({
          id: "job-cancelled",
          checkpoint: {},
        }),
        request,
        stepRows: [],
        synthesisInput: partial<ProviderGenerationInput>({
          signal: controller.signal,
        }),
        generate: async () => {
          controller.abort();
          return partial<ProviderGeneration>({
            text: JSON.stringify(__fallbackAnswer(request, [])),
          });
        },
        store,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store).not.toHaveBeenCalled();
  });

  it("adds at most one bounded retry pass for failed local tools", () => {
    const plan = __planInvestigation(request);
    const revised = __buildRetryPlan(
      plan,
      partial<AiInvestigationStepRow[]>([
        { stepId: "documents", state: "failed" },
        { stepId: "saved-analysis", state: "completed" },
      ]),
      ["documents", "saved-analysis", "documents"],
    );
    expect(revised.steps.slice(plan.steps.length)).toEqual([
      expect.objectContaining({
        id: "retry-documents",
        tool: "searchLocalResearchDocuments",
        dependsOn: ["documents"],
        canRunInParallel: false,
      }),
    ]);
  });

  it("does not replay attempted external steps on explicit resume", () => {
    expect(
      __shouldReuseStep(
        partial<AiInvestigationStepRow>({ state: "failed", attempt: 1 }),
        partial<AiPlanStep>({ tool: "searchPublicResearchWeb" }),
        true,
      ),
    ).toBe(true);
    expect(
      __shouldReuseStep(
        partial<AiInvestigationStepRow>({ state: "failed", attempt: 1 }),
        partial<AiPlanStep>({ tool: "searchLocalResearchDocuments" }),
        true,
      ),
    ).toBe(false);
  });
});
