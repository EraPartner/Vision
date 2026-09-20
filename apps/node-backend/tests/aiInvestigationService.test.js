import { describe, expect, it, vi } from "vitest";
import {
  __evidenceFromSteps,
  __fallbackAnswer,
  __buildRetryPlan,
  __planInvestigation,
  __shouldReuseStep,
  __usesCloudSynthesis,
  __applyPlannerOrdering,
  __resolveProviderAnswer,
  __shouldPreserveProviderCheckpoint,
  resumeRecoverableInvestigations,
} from "../src/services/aiInvestigationService.js";

const request = {
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
};

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

  it("uses only explicitly selected evidence for cloud synthesis", () => {
    const plan = __planInvestigation({
      ...request,
      route: "openai-api",
      selectedEvidence:
        "Question: Which recipient cost most? Evidence: Recipient A totalled EUR 1200.",
    });
    expect(plan.steps).toEqual([
      expect.objectContaining({
        id: "selected-evidence",
        tool: "useSelectedEvidence",
        args: {},
      }),
    ]);
    expect(plan.steps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "searchLocalResearchDocuments" }),
      ]),
    );
    expect(
      __usesCloudSynthesis({
        route: "openai-api",
        selectedEvidence: "Approved evidence",
      }),
    ).toBe(true);
    expect(
      __usesCloudSynthesis({
        route: "openai-api",
        selectedSummary: "Planning summary",
        selectedEvidence: null,
      }),
    ).toBe(false);
  });

  it("adds only validated cloud catalog plans to the local execution queue", () => {
    const cloudRequest = {
      ...request,
      route: "openai-api",
      scope: { ...request.scope, workspaces: ["budgeting"] },
    };
    const baseline = __planInvestigation(cloudRequest);
    const plan = __applyPlannerOrdering(
      JSON.stringify({
        stepIds: [],
        analysisPlans: [
          {
            schemaVersion: 1,
            catalogVersion: 1,
            datasetId: "cash-flows",
            fields: ["month"],
            filters: [],
            groups: ["month"],
            measures: ["sum_spending"],
            joins: [],
            orderBy: [{ id: "month", direction: "asc" }],
            limit: 100,
            formulas: [],
          },
        ],
      }),
      baseline,
      "openai",
      cloudRequest,
    );
    expect(plan.steps.at(-1)).toMatchObject({
      tool: "executeCatalogAnalysis",
      args: { analysisPlan: { datasetId: "cash-flows" } },
    });
    expect(plan.steps.at(-1).args).not.toHaveProperty("sql");
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
    const evidence = __evidenceFromSteps([
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
    ]);
    expect(evidence[0]).toMatchObject({
      id: "document:doc:v2:p3",
      kind: "document",
      locator: "annual.md · section Risk · passage 3",
      excerpt: "Demand declined during the quarter.",
    });
  });

  it("renders selected cloud evidence as one bounded citation", () => {
    const evidence = __evidenceFromSteps([
      {
        stepId: "selected-evidence",
        state: "completed",
        result: {
          data: { text: "Recipient A totalled EUR 1200." },
        },
      },
    ]);
    expect(evidence).toEqual([
      expect.objectContaining({
        id: "selected-evidence",
        locator: "cloud-disclosure:selected-evidence",
        excerpt: "Recipient A totalled EUR 1200.",
      }),
    ]);
  });

  it("localizes an abstention when no valid synthesis is available", () => {
    const answer = __fallbackAnswer({ ...request, language: "nl" }, []);
    expect(answer.status).toBe("abstained");
    expect(answer.language).toBe("nl");
    expect(answer.summary).toContain("onvoldoende geverifieerd bewijs");
  });

  it("queues unfinished durable jobs again after startup", async () => {
    const resumed = [];
    const count = await resumeRecoverableInvestigations({
      list: async () => [{ id: "oldest" }, { id: "newest" }],
      run: async (id) => resumed.push(id),
    });
    expect(count).toBe(2);
    expect(resumed).toEqual(["oldest", "newest"]);
  });

  it("restores a checkpointed provider-form answer after restart without another model call", async () => {
    const checkpointed = __fallbackAnswer(request, []);
    const generateProvider = vi.fn();
    const generateLocal = vi.fn();
    const store = vi.fn();
    const resolved = await __resolveProviderAnswer({
      job: { id: "job-1", checkpoint: { providerResult: checkpointed } },
      request: {
        ...request,
        route: "openai-api",
        selectedEvidence: "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]",
      },
      stepRows: [],
      synthesisInput: {},
      generateProvider,
      generateLocal,
      store,
    });
    expect(resolved).toEqual(checkpointed);
    expect(generateProvider).not.toHaveBeenCalled();
    expect(generateLocal).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("does not checkpoint a provider answer after the investigation was cancelled", async () => {
    const controller = new AbortController();
    const store = vi.fn();
    await expect(
      __resolveProviderAnswer({
        job: { id: "job-cancelled", checkpoint: {} },
        request: {
          ...request,
          route: "openai-api",
          selectedEvidence: "Fictional selected evidence",
        },
        stepRows: [],
        synthesisInput: { signal: controller.signal },
        generateProvider: async () => {
          controller.abort();
          return { text: JSON.stringify(__fallbackAnswer(request, [])) };
        },
        generateLocal: vi.fn(),
        store,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store).not.toHaveBeenCalled();
  });

  it("preserves a provider checkpoint when retrying local reference restoration", () => {
    expect(
      __shouldPreserveProviderCheckpoint({
        state: "failed",
        error: { code: "REFERENCE_KEY_UNAVAILABLE" },
      }),
    ).toBe(true);
    expect(
      __shouldPreserveProviderCheckpoint({
        state: "failed",
        error: { code: "SYNTHESIS_FAILED" },
      }),
    ).toBe(false);
    expect(
      __shouldPreserveProviderCheckpoint({
        state: "partial",
        error: { code: "REFERENCE_KEY_UNAVAILABLE" },
      }),
    ).toBe(false);
  });

  it("adds at most one bounded retry pass for failed local tools", () => {
    const plan = __planInvestigation(request);
    const revised = __buildRetryPlan(
      plan,
      [
        { stepId: "documents", state: "failed" },
        { stepId: "saved-analysis", state: "completed" },
      ],
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
        { state: "failed", attempt: 1 },
        { tool: "searchPublicResearchWeb" },
        true,
      ),
    ).toBe(true);
    expect(
      __shouldReuseStep(
        { state: "failed", attempt: 1 },
        { tool: "searchLocalResearchDocuments" },
        true,
      ),
    ).toBe(false);
  });
});
