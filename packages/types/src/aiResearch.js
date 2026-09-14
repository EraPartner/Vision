import { z } from "zod";

export const AI_INVESTIGATION_STATUSES = Object.freeze([
  "queued",
  "running",
  "waiting",
  "partial",
  "completed",
  "failed",
  "cancelled",
]);

export const AI_DISCLOSURE_MODES = Object.freeze([
  "local-only",
  "cloud-plan-public",
  "selected-summary",
  "cloud-synthesis-selected",
]);

export const aiEvidenceReferenceSchema = z.strictObject({
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

export const aiAnswerSchema = z
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

export const aiInvestigationScopeSchema = z
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

export const aiInvestigationRequestSchema = z
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

export const aiPlanStepSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
  args: z.record(z.string(), z.unknown()),
  purpose: z.string().min(1).max(500),
  dependsOn: z.array(z.string()).max(20).default([]),
  canRunInParallel: z.boolean().default(false),
});

export const aiInvestigationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resolvedScope: aiInvestigationScopeSchema,
  assumptions: z.array(z.string().min(1).max(1000)).max(50),
  ambiguity: z.strictObject({
    material: z.boolean(),
    question: z.string().max(1000).nullable(),
  }),
  steps: z.array(aiPlanStepSchema).min(1).max(24),
  answerDepth: z.enum(["quick", "detailed"]),
  language: z.enum(["en", "nl"]),
});

export const aiAnalysisEditProposalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  savedAnalysisId: z.string().min(1),
  baseVersion: z.number().int().positive(),
  rationale: z.string().min(1).max(2000),
  operations: z
    .array(
      z.strictObject({
        op: z.enum(["add", "replace", "remove"]),
        path: z.string().regex(/^\/(name|parameters|charts|querySpec)(\/.*)?$/),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(30),
});

export const aiDisclosureGrantSchema = z.strictObject({
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

export function assertAiAnswer(value) {
  return aiAnswerSchema.parse(value);
}

export function assertAiInvestigationPlan(value) {
  return aiInvestigationPlanSchema.parse(value);
}
