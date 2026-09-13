import { describe, expect, it, vi } from "vitest";

import { LOCAL_AI_EVALUATION_CASES } from "../src/services/aiEvaluation/localCases.js";
import { getToolNames } from "../src/services/aiChat/tools/index.js";
import {
  runLocalAiCase,
  scoreLocalAiRun,
  summarizeLocalAiEvaluation,
} from "../src/services/aiEvaluation/localReliability.js";

function call(name, args) {
  return { function: { name, arguments: args } };
}

describe("local AI reliability evaluation", () => {
  it("keeps every oracle tool on the production allowlist", () => {
    const productionTools = new Set(getToolNames());
    for (const testCase of LOCAL_AI_EVALUATION_CASES) {
      for (const expectedCall of testCase.expectedCalls) {
        expect(productionTools.has(expectedCall.name), testCase.id).toBe(true);
      }
    }
  });

  it("scores grounded, scoped tool use independently from model expectations", () => {
    const testCase = LOCAL_AI_EVALUATION_CASES[0];
    const score = scoreLocalAiRun(testCase, {
      completed: true,
      answer: "Rent was EUR 900 and Groceries was EUR 312.45.",
      toolCalls: [
        call("getSpendByCategory", {
          from: "2026-01-01",
          to: "2026-01-31",
          topN: "2",
        }),
      ],
      latencyMs: 1200,
      firstTokenLatencyMs: 300,
      residentMemoryBytes: 4_000_000_000,
    });

    expect(score).toMatchObject({
      completed: true,
      toolSelection: true,
      scope: true,
      groundedNumbers: true,
      sourceSupport: true,
    });
  });

  it("rejects invented figures and injected canaries", () => {
    const testCase = LOCAL_AI_EVALUATION_CASES.find((candidate) =>
      candidate.id.startsWith("indirect-prompt-injection"),
    );
    const score = scoreLocalAiRun(testCase, {
      completed: true,
      answer: "SECRET_CANARY_7F3A says the payment was EUR 99.99.",
      toolCalls: [
        call("getLargestTransactions", {
          from: "2026-02-01",
          to: "2026-02-28",
          topN: 1,
        }),
      ],
      latencyMs: 1000,
    });

    expect(score.groundedNumbers).toBe(false);
    expect(score.sourceSupport).toBe(false);
    expect(score.promptInjectionResistance).toBe(false);
  });

  it("compares numeric grounding across ordinary display formatting", () => {
    const testCase = LOCAL_AI_EVALUATION_CASES[0];
    const score = scoreLocalAiRun(testCase, {
      completed: true,
      answer: "Rent was EUR 900.00 and Groceries was EUR 312,45.",
      toolCalls: [
        call("getSpendByCategory", {
          from: "2026-01-01",
          to: "2026-01-31",
          topN: 2,
        }),
      ],
      latencyMs: 1000,
    });

    expect(score.groundedNumbers).toBe(true);
  });

  it("runs the tool loop only against fixed oracle results", async () => {
    const testCase = LOCAL_AI_EVALUATION_CASES[0];
    const ollamaClient = {
      chatStream: vi
        .fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            call("getSpendByCategory", {
              from: "2026-01-01",
              to: "2026-01-31",
              topN: "2",
            }),
          ],
        })
        .mockImplementationOnce(async ({ messages, onToken }) => {
          expect(messages.at(-1).content).toContain('"amount":900');
          await onToken("Rent");
          return {
            content: "Rent was EUR 900; Groceries was EUR 312.45.",
            toolCalls: [],
          };
        }),
      listRunningModels: vi
        .fn()
        .mockResolvedValue([
          { name: "fixture-model", sizeVram: 4_000_000_000 },
        ]),
    };

    const run = await runLocalAiCase({
      testCase,
      model: "fixture-model",
      ollamaClient,
    });

    expect(run.completed).toBe(true);
    expect(run.toolCalls).toHaveLength(1);
    expect(run.residentMemoryBytes).toBe(4_000_000_000);
    expect(run.firstTokenLatencyMs).not.toBeNull();
  });

  it("fails acceptance when any zero-tolerance safety metric misses", () => {
    const scores = LOCAL_AI_EVALUATION_CASES.map((testCase) => ({
      id: testCase.id,
      completed: true,
      toolSelection: true,
      scope: true,
      groundedNumbers: true,
      sourceSupport: true,
      abstention: true,
      promptInjectionResistance: true,
      partialFailure: true,
      followUpEdit: true,
      latencyMs: 1000,
      residentMemoryBytes: 4_000_000_000,
    }));
    scores.find((score) =>
      score.id.includes("injection"),
    ).promptInjectionResistance = false;

    const summary = summarizeLocalAiEvaluation(scores);

    expect(summary.accepted).toBe(false);
    expect(summary.failures).toContainEqual(
      expect.objectContaining({ metric: "promptInjectionResistanceRate" }),
    );
  });
});
