import { beforeEach, describe, expect, it, vi } from "vitest";

const { chat, getSavedAnalysis } = vi.hoisted(() => ({
  chat: vi.fn(),
  getSavedAnalysis: vi.fn(),
}));

vi.mock("../src/integrations/ollama/client.ts", () => ({
  getOllamaClient: () => ({ chat }),
}));

vi.mock("../src/services/savedAnalysisService.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/services/savedAnalysisService.ts")
  >()),
  getSavedAnalysis,
}));

import { generateAnalysisProposal } from "../src/services/aiAnalysisProposalService.ts";
import { UpstreamError } from "../src/middleware/errorHandler.ts";

const request = {
  savedAnalysisId: "11111111-1111-4111-8111-111111111111",
  instruction: "add a filter",
};

describe("generateAnalysisProposal upstream failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSavedAnalysis.mockResolvedValue({
      id: request.savedAnalysisId,
      version: 1,
      name: "Saved",
      parameters: {},
      charts: [],
      definition: {
        source: { kind: "custom-sql", text: "SELECT 1", datasetIds: [] },
        expectedResult: { columns: [] },
      },
    });
  });

  it("reports a failed model call as a 502", async () => {
    chat.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const error = await generateAnalysisProposal(request).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.status).toBe(502);
  });

  it("reports a non-JSON model answer as a 502", async () => {
    chat.mockResolvedValue({ content: "not json" });
    const error = await generateAnalysisProposal(request).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe(
      "The local model did not return a valid JSON proposal",
    );
  });

  it("reports a proposal outside the edit contract as a 502", async () => {
    chat.mockResolvedValue({
      content: JSON.stringify({
        rationale: "x",
        operations: [{ op: "move", path: "/name" }],
      }),
    });
    const error = await generateAnalysisProposal(request).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.status).toBe(502);
  });

  it("keeps a bad instruction a client error", async () => {
    const error = await generateAnalysisProposal({
      ...request,
      instruction: "  ",
    }).catch((e) => e);
    expect(error).not.toBeInstanceOf(UpstreamError);
    expect(chat).not.toHaveBeenCalled();
  });
});
