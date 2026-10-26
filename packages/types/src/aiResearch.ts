import { z } from "zod";

export interface AiEvidenceReference {
  id: string;
  kind: "calculation" | "analysis" | "document" | "web" | "research-service";
  label: string;
  sourceDate: string | null;
  locator: string;
  excerpt: string | null;
  available: boolean;
}
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
  evidence: AiEvidenceReference[];
  analysisReference: { id: string; version: number } | null;
}
export interface AiInvestigationScope {
  workspaces: Array<"budgeting" | "portfolio" | "research" | "cross-workspace">;
  accountIds: number[];
  investmentIds: number[];
  dateFrom: string | null;
  dateTo: string | null;
  currency: string;
  constraints: string[];
}
export interface AiInvestigationRequest {
  question: string;
  route: "local";
  researchMode: "local-only" | "public-providers" | "public-web";
  publicWebQuery: string | null;
  publicSymbols: string[];
  publicMacroQueries: string[];
  clarification: string | null;
  model: string | null;
  depth: "quick" | "detailed";
  language: "en" | "nl";
  scope: AiInvestigationScope;
  savedAnalysisId: string | null;
}
export interface AiPlanStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
  dependsOn: string[];
  canRunInParallel: boolean;
}
export interface AiInvestigationPlan {
  schemaVersion: 1;
  resolvedScope: AiInvestigationRequest["scope"];
  assumptions: string[];
  ambiguity: { material: boolean; question: string | null };
  steps: AiPlanStep[];
  answerDepth: "quick" | "detailed";
  language: "en" | "nl";
}
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
export const AI_INVESTIGATION_STATUSES = Object.freeze([
  "queued",
  "running",
  "waiting",
  "partial",
  "completed",
  "failed",
  "cancelled",
] as const);

export const aiEvidenceReferenceSchema: z.ZodType<AiEvidenceReference> =
  z.strictObject({
    id: z.string().min(1).max(160),
    kind: z.enum([
      "calculation",
      "analysis",
      "document",
      "web",
      "research-service",
    ]),
    label: z.string().min(1).max(300),
    sourceDate: z.string().max(40).nullable().default(null),
    locator: z.string().min(1).max(1000),
    excerpt: z.string().max(2000).nullable().default(null),
    available: z.boolean().default(true),
  });

export const aiAnswerSchema: z.ZodType<AiAnswer> = z
  .strictObject({
    schemaVersion: z.literal(1),
    status: z.enum(["complete", "qualified", "abstained", "partial"]),
    depth: z.enum(["quick", "detailed"]),
    language: z.enum(["en", "nl"]),
    summary: z.string().min(1).max(12000),
    facts: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          evidenceIds: z.array(z.string()).min(1).max(20),
        }),
      )
      .max(100),
    calculations: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          evidenceIds: z.array(z.string()).min(1).max(20),
        }),
      )
      .max(100),
    interpretations: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          evidenceIds: z.array(z.string()).min(1).max(20),
        }),
      )
      .max(100),
    assumptions: z.array(z.string().min(1).max(1000)).max(50),
    missingInformation: z.array(z.string().min(1).max(1000)).max(50),
    conflicts: z
      .array(
        z.strictObject({
          description: z.string().min(1).max(2000),
          evidenceIds: z.array(z.string()).min(2).max(20),
        }),
      )
      .max(50),
    evidence: z.array(aiEvidenceReferenceSchema).max(200),
    analysisReference: z
      .strictObject({ id: z.string(), version: z.number().int().positive() })
      .nullable()
      .default(null),
  })
  .superRefine((answer, ctx) => {
    const known = new Set(answer.evidence.map((item) => item.id));
    const references = [
      ...answer.facts.flatMap((item) => item.evidenceIds),
      ...answer.calculations.flatMap((item) => item.evidenceIds),
      ...answer.interpretations.flatMap((item) => item.evidenceIds),
      ...answer.conflicts.flatMap((item) => item.evidenceIds),
    ];
    for (const id of references) {
      if (!known.has(id))
        ctx.addIssue({ code: "custom", message: `Unknown evidence id: ${id}` });
    }
  });

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Date must be a real calendar date");

export const aiInvestigationScopeSchema: z.ZodType<AiInvestigationScope> = z
  .strictObject({
    workspaces: z
      .array(z.enum(["budgeting", "portfolio", "research", "cross-workspace"]))
      .min(1)
      .max(4),
    accountIds: z.array(z.number().int().positive()).max(100).default([]),
    investmentIds: z.array(z.number().int().positive()).max(100).default([]),
    dateFrom: calendarDateSchema.nullable().default(null),
    dateTo: calendarDateSchema.nullable().default(null),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("EUR"),
    constraints: z.array(z.string().min(1).max(500)).max(30).default([]),
  })
  .superRefine((scope, ctx) => {
    if (scope.dateFrom && scope.dateTo && scope.dateFrom > scope.dateTo)
      ctx.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "dateTo must not be before dateFrom",
      });
  });

export const aiInvestigationRequestSchema: z.ZodType<AiInvestigationRequest> = z
  .strictObject({
    question: z.string().min(1).max(8000),
    route: z.literal("local").default("local"),
    researchMode: z
      .enum(["local-only", "public-providers", "public-web"])
      .default("local-only"),
    publicWebQuery: z.string().min(1).max(300).nullable().default(null),
    publicSymbols: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/))
      .max(3)
      .default([]),
    publicMacroQueries: z.array(z.string().min(1).max(120)).max(3).default([]),
    clarification: z.string().min(1).max(1000).nullable().default(null),
    model: z.string().min(1).max(200).nullable().default(null),
    depth: z.enum(["quick", "detailed"]).default("quick"),
    language: z.enum(["en", "nl"]).default("en"),
    scope: aiInvestigationScopeSchema,
    savedAnalysisId: z.string().max(100).nullable().default(null),
  })
  .superRefine((request, ctx) => {
    if (request.researchMode === "public-web" && !request.publicWebQuery)
      ctx.addIssue({
        code: "custom",
        path: ["publicWebQuery"],
        message:
          "Public web research requires a separately authored public query",
      });
    if (
      request.researchMode === "public-providers" &&
      request.publicSymbols.length === 0 &&
      request.publicMacroQueries.length === 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["publicSymbols"],
        message:
          "Public provider research requires an explicit public symbol or macro query",
      });
  });

export const aiPlanStepSchema: z.ZodType<AiPlanStep> = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
  args: z.record(z.string(), z.unknown()),
  purpose: z.string().min(1).max(500),
  dependsOn: z.array(z.string()).max(20).default([]),
  canRunInParallel: z.boolean().default(false),
});

// Widened to ZodType so the key stays required when consumers type-check this
// file without strictNullChecks (zod would otherwise infer `question?:`).
const ambiguityQuestionSchema: z.ZodType<string | null> = z
  .string()
  .max(1000)
  .nullable();

export const aiInvestigationPlanSchema: z.ZodType<AiInvestigationPlan> =
  z.strictObject({
    schemaVersion: z.literal(1),
    resolvedScope: aiInvestigationScopeSchema,
    assumptions: z.array(z.string().min(1).max(1000)).max(50),
    ambiguity: z.strictObject({
      material: z.boolean(),
      question: ambiguityQuestionSchema,
    }),
    steps: z.array(aiPlanStepSchema).min(1).max(24),
    answerDepth: z.enum(["quick", "detailed"]),
    language: z.enum(["en", "nl"]),
  });

export const aiAnalysisEditProposalSchema: z.ZodType<AiAnalysisEditProposal> =
  z.strictObject({
    schemaVersion: z.literal(1),
    savedAnalysisId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    rationale: z.string().min(1).max(2000),
    operations: z
      .array(
        z.strictObject({
          op: z.enum(["add", "replace", "remove"]),
          path: z
            .string()
            .regex(/^\/(name|parameters|charts|querySpec)(\/.*)?$/),
          value: z.unknown().optional(),
        }),
      )
      .min(1)
      .max(30),
  });

export function assertAiAnswer(value: unknown): AiAnswer {
  return aiAnswerSchema.parse(value);
}

export function assertAiInvestigationPlan(value: unknown): AiInvestigationPlan {
  return aiInvestigationPlanSchema.parse(value);
}
