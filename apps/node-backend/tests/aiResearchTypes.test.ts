import { describe, expect, it } from "vitest";
import {
  aiAnswerSchema,
  aiInvestigationRequestSchema,
} from "@vision/types/aiResearch";

describe("AI research contracts", () => {
  it("defaults investigations to local-only", () => {
    const parsed = aiInvestigationRequestSchema.parse({
      question: "What changed?",
      scope: { workspaces: ["research"] },
    });
    expect(parsed.route).toBe("local");
    expect(parsed.researchMode).toBe("local-only");
  });
  it("rejects dangling evidence references", () => {
    const answer = {
      schemaVersion: 1,
      status: "complete",
      depth: "quick",
      language: "en",
      summary: "x",
      facts: [{ text: "fact", evidenceIds: ["missing"] }],
      calculations: [],
      interpretations: [],
      assumptions: [],
      missingInformation: [],
      conflicts: [],
      evidence: [],
      analysisReference: null,
    };
    expect(aiAnswerSchema.safeParse(answer).success).toBe(false);
  });
  it("requires a separately authored query for public web research", () => {
    const base = {
      question: "What does my private history imply?",
      researchMode: "public-web",
      scope: { workspaces: ["research"] },
    };
    expect(aiInvestigationRequestSchema.safeParse(base).success).toBe(false);
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        publicWebQuery: "Belgian inflation outlook 2026",
      }).success,
    ).toBe(true);
  });
  it("rejects the removed OpenAI route and its cloud-only fields", () => {
    const base = {
      question: "Private question",
      scope: { workspaces: ["research"] },
    };
    expect(
      aiInvestigationRequestSchema.safeParse({ ...base, route: "openai-api" })
        .success,
    ).toBe(false);
    for (const field of [
      { publicQuestion: "Public question" },
      { selectedEvidence: "Evidence" },
      { selectedSummary: "Summary" },
      { grantId: "11111111-1111-4111-8111-111111111111" },
      { referenceScopeId: "11111111-1111-4111-8111-111111111111" },
    ])
      expect(
        aiInvestigationRequestSchema.safeParse({ ...base, ...field }).success,
      ).toBe(false);
  });
  it("rejects impossible and reversed scope dates", () => {
    const base = {
      question: "What changed?",
      scope: { workspaces: ["budgeting"] },
    };
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        scope: { ...base.scope, dateFrom: "2026-02-30" },
      }).success,
    ).toBe(false);
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        scope: {
          ...base.scope,
          dateFrom: "2026-12-31",
          dateTo: "2026-01-01",
        },
      }).success,
    ).toBe(false);
  });
});
