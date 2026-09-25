import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  check: vi.fn(),
  reserve: vi.fn(),
  broker: vi.fn(),
}));
vi.mock("../src/config/config.js", () => ({
  default: {
    database: {
      analysisUrl: "postgresql://synthetic.invalid/vision_test",
    },
    aiResearch: {
      openai: {
        enabled: true,
        model: "synthetic-model",
        models: [
          {
            id: "synthetic-model",
            inputMicrosPerMillion: 100,
            outputMicrosPerMillion: 200,
          },
        ],
        monthlyBudgetMicros: 1_000_000,
        maxRetries: 0,
        timeoutMs: 1000,
      },
    },
  },
}));
vi.mock("../src/services/agentCloakPreflight.js", () => ({
  checkAgentCloakPreflight: mocked.check,
}));
vi.mock("../src/repositories/aiDisclosureRepository.js", () => ({
  findUncertainDisclosure: vi.fn(),
  reserveDisclosure: mocked.reserve,
  updateDisclosureRecord: vi.fn(),
}));
vi.mock("../src/integrations/openai/brokerClient.js", () => ({
  callOpenAiBroker: mocked.broker,
}));

import { generateWithProvider } from "../src/services/aiProviderAdapters.js";

describe("AgentCloak provider gate", () => {
  it("stops direct cloud jobs before reservation or OpenAI when the preflight blocks", async () => {
    mocked.check.mockReset().mockRejectedValueOnce(
      Object.assign(new Error("Sensitive text"), {
        code: "AGENTCLOAK_SENSITIVE_TEXT",
      }),
    );
    mocked.reserve.mockReset();
    mocked.broker.mockReset();
    const request = {
      question: "Private investigation question",
      route: "openai-api",
      publicQuestion: null,
      selectedSummary: "Approved synthetic summary",
      selectedEvidence: null,
      model: "synthetic-model",
      depth: "quick",
      language: "en",
      researchMode: "local-only",
      scope: { workspaces: ["research"], constraints: [] },
      publicSymbols: [],
      publicMacroQueries: [],
      savedAnalysisId: null,
      grantId: "synthetic-grant-id",
    };
    await expect(
      generateWithProvider({
        jobId: "synthetic-job-id",
        request,
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "AGENTCLOAK_SENSITIVE_TEXT" });
    expect(mocked.check).toHaveBeenCalledWith(
      expect.objectContaining({ selectedSummary: request.selectedSummary }),
      expect.any(Object),
    );
    expect(mocked.check.mock.calls[0][0]).not.toHaveProperty("question");
    expect(mocked.check.mock.calls[0][0]).not.toHaveProperty("constraints");
    expect(mocked.reserve).not.toHaveBeenCalled();
    expect(mocked.broker).not.toHaveBeenCalled();
  });
});
