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
  scope: AiInvestigationScope;
  grantId: string | null;
  selectedSummary: string | null;
  selectedEvidence: string | null;
  referenceScopeId: string | null;
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
export interface AiCloudAnalysisPlan {
  schemaVersion: 1;
  catalogVersion: number;
  datasetId: "transactions" | "accounts" | "holdings" | "cash-flows";
  fields: string[];
  filters: Array<{
    fieldId: string;
    operator:
      | "eq"
      | "neq"
      | "lt"
      | "lte"
      | "gt"
      | "gte"
      | "contains"
      | "starts-with"
      | "is-null"
      | "is-not-null";
    value?: string | number | boolean;
  }>;
  groups: string[];
  measures: string[];
  joins: string[];
  orderBy: Array<{ id: string; direction: "asc" | "desc" }>;
  limit: number;
  formulas: Array<{
    id: string;
    label: string;
    expression: string;
    scope: "row" | "summary";
    resultType: "decimal" | "integer" | "boolean" | "string";
    dependencies: string[];
  }>;
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

export const AI_INVESTIGATION_STATUSES = Object.freeze([
  "queued",
  "running",
  "waiting",
  "partial",
  "completed",
  "failed",
  "cancelled",
] as const);

export const AI_DISCLOSURE_MODES = Object.freeze([
  "local-only",
  "cloud-plan-public",
  "selected-summary",
  "cloud-synthesis-selected",
] as const);

export const AI_REVERSIBLE_REFERENCE_TYPES = Object.freeze([
  "account",
  "recipient",
  "investment",
  "holding",
  "category",
  "document",
  "subject",
  "amount",
  "date",
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
    route: z.enum(["local", "openai-api"]).default("local"),
    researchMode: z
      .enum(["local-only", "public-providers", "public-web"])
      .default("local-only"),
    publicQuestion: z.string().min(1).max(1000).nullable().default(null),
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
    grantId: z.string().uuid().nullable().default(null),
    selectedSummary: z.string().max(8000).nullable().default(null),
    selectedEvidence: z.string().max(24000).nullable().default(null),
    referenceScopeId: z.string().uuid().nullable().default(null),
    savedAnalysisId: z.string().max(100).nullable().default(null),
  })
  .superRefine((request, ctx) => {
    const cloudInputCount = [
      request.publicQuestion,
      request.selectedSummary,
      request.selectedEvidence,
    ].filter(Boolean).length;
    if (request.route === "openai-api" && cloudInputCount === 0)
      ctx.addIssue({
        code: "custom",
        path: ["publicQuestion"],
        message:
          "OpenAI requires a public question, selected summary, or selected evidence",
      });
    if (request.route === "openai-api" && cloudInputCount > 1)
      ctx.addIssue({
        code: "custom",
        path: ["selectedEvidence"],
        message: "Select exactly one OpenAI disclosure mode",
      });
    if (
      request.referenceScopeId &&
      (request.route !== "openai-api" ||
        (!request.selectedSummary && !request.selectedEvidence))
    )
      ctx.addIssue({
        code: "custom",
        path: ["referenceScopeId"],
        message:
          "A reversible reference scope belongs to one selected-summary or selected-evidence cloud request",
      });
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

const cloudAnalysisValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
]);
const cloudAnalysisFilterSchema = z
  .strictObject({
    fieldId: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    operator: z.enum([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "starts-with",
      "is-null",
      "is-not-null",
    ]),
    value: cloudAnalysisValueSchema.optional(),
  })
  .superRefine((filter, ctx) => {
    const unary = ["is-null", "is-not-null"].includes(filter.operator);
    if (unary === (filter.value !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: unary
          ? "Unary filters cannot carry a value"
          : "This filter requires a scalar value",
      });
  });

export const aiCloudAnalysisPlanSchema: z.ZodType<AiCloudAnalysisPlan> =
  z.strictObject({
    schemaVersion: z.literal(1),
    catalogVersion: z.number().int().positive(),
    datasetId: z.enum(["transactions", "accounts", "holdings", "cash-flows"]),
    fields: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/))
      .max(24)
      .default([]),
    filters: z.array(cloudAnalysisFilterSchema).max(24).default([]),
    groups: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/))
      .max(12)
      .default([]),
    measures: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/))
      .max(12)
      .default([]),
    joins: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/))
      .max(4)
      .default([]),
    orderBy: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
          direction: z.enum(["asc", "desc"]),
        }),
      )
      .max(8)
      .default([]),
    limit: z.number().int().min(1).max(500).default(100),
    formulas: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          label: z.string().min(1).max(120),
          expression: z.string().min(1).max(1000),
          scope: z.enum(["row", "summary"]).default("row"),
          resultType: z.enum(["decimal", "integer", "boolean", "string"]),
          dependencies: z
            .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/))
            .max(24)
            .default([]),
        }),
      )
      .max(12)
      .default([]),
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

export const aiDisclosureGrantSchema: z.ZodType<AiDisclosureGrant> =
  z.strictObject({
    route: z.literal("openai-api"),
    mode: z.enum([
      "cloud-plan-public",
      "selected-summary",
      "cloud-synthesis-selected",
    ]),
    purpose: z.string().min(1).max(500),
    previewHash: z.string().regex(/^[0-9a-f]{64}$/),
    allowedFields: z
      .array(
        z.enum([
          "question",
          "publicSchema",
          "language",
          "depth",
          "constraints",
          "selectedSummary",
          "selectedEvidence",
          "citations",
        ]),
      )
      .min(1)
      .max(8),
    maxRequests: z.number().int().min(1).max(50),
    maxInputCharacters: z.number().int().min(100).max(200000),
    maxOutputTokens: z.number().int().min(64).max(32000),
    maxCostMicros: z.number().int().min(0).max(100000000),
    maxDisclosureUnits: z.number().int().min(1).max(10000),
    expiresAt: z.string().datetime(),
    retainExactPayload: z.boolean().default(false),
  });

export function assertAiAnswer(value: unknown): AiAnswer {
  return aiAnswerSchema.parse(value);
}

export function assertAiInvestigationPlan(value: unknown): AiInvestigationPlan {
  return aiInvestigationPlanSchema.parse(value);
}
