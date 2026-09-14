import type { z } from "zod";
export declare const AI_INVESTIGATION_STATUSES: readonly [
  "queued",
  "running",
  "waiting",
  "partial",
  "completed",
  "failed",
  "cancelled",
];
export declare const AI_DISCLOSURE_MODES: readonly [
  "local-only",
  "cloud-plan-public",
  "selected-summary",
  "cloud-synthesis-selected",
];
export declare const aiEvidenceReferenceSchema: z.ZodTypeAny;
export interface AiAnswer {
  schemaVersion: 1;
  status: "complete" | "qualified" | "abstained" | "partial";
  depth: "quick" | "detailed";
  language: "en" | "nl";
  summary: string;
  facts: Array<{ text: string; evidenceIds: string[] }>;
  calculations: Array<{ text: string; evidenceIds: string[] }>;
  interpretations: Array<{ text: string; evidenceIds: string[] }>;
  assumptions: string[];
  missingInformation: string[];
  conflicts: Array<{ description: string; evidenceIds: string[] }>;
  evidence: any[];
  analysisReference: { id: string; version: number } | null;
}
export declare const aiAnswerSchema: z.ZodType<AiAnswer>;
export declare const aiInvestigationScopeSchema: z.ZodTypeAny;
export interface AiInvestigationRequest {
  question: string;
  route: "local" | "openai-api";
  researchMode: "local-only" | "public-providers" | "public-web";
  publicQuestion: string | null;
  publicWebQuery: string | null;
  publicSymbols: string[];
  publicMacroQueries: string[];
  clarification: string | null;
  model: string | null;
  depth: "quick" | "detailed";
  language: "en" | "nl";
  scope: {
    workspaces: Array<
      "budgeting" | "portfolio" | "research" | "cross-workspace"
    >;
    accountIds: number[];
    investmentIds: number[];
    dateFrom: string | null;
    dateTo: string | null;
    currency: string;
    constraints: string[];
  };
  grantId: string | null;
  selectedSummary: string | null;
  selectedEvidence: string | null;
  savedAnalysisId: string | null;
}
export declare const aiInvestigationRequestSchema: z.ZodType<AiInvestigationRequest>;
export declare const aiPlanStepSchema: z.ZodTypeAny;
export interface AiInvestigationPlan {
  schemaVersion: 1;
  resolvedScope: AiInvestigationRequest["scope"];
  assumptions: string[];
  ambiguity: { material: boolean; question: string | null };
  steps: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    purpose: string;
    dependsOn: string[];
    canRunInParallel: boolean;
  }>;
  answerDepth: "quick" | "detailed";
  language: "en" | "nl";
}
export declare const aiInvestigationPlanSchema: z.ZodType<AiInvestigationPlan>;
export interface AiAnalysisEditProposal {
  schemaVersion: 1;
  savedAnalysisId: string;
  baseVersion: number;
  rationale: string;
  operations: Array<{
    op: "add" | "replace" | "remove";
    path: string;
    value?: unknown;
  }>;
}
export declare const aiAnalysisEditProposalSchema: z.ZodType<AiAnalysisEditProposal>;
export interface AiDisclosureGrant {
  route: "openai-api";
  mode: "cloud-plan-public" | "selected-summary" | "cloud-synthesis-selected";
  purpose: string;
  previewHash: string;
  allowedFields: string[];
  maxRequests: number;
  maxInputCharacters: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxDisclosureUnits: number;
  expiresAt: string;
  retainExactPayload: boolean;
}
export declare const aiDisclosureGrantSchema: z.ZodType<AiDisclosureGrant>;
export declare function assertAiAnswer(value: unknown): AiAnswer;
export declare function assertAiInvestigationPlan(
  value: unknown,
): AiInvestigationPlan;
