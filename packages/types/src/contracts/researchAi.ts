import { z } from "zod";

/*
 * Wire contracts for /api/ai-research (routes/aiResearch.ts and
 * routes/aiResearchDocuments.ts). Row shapes follow the backend's row
 * schemas in database/rows/ai.ts; JSONB columns whose deep shape changed
 * over time (scope, result, error, policy snapshot) stay unchecked here
 * because the backend narrows them itself.
 */

const CountSchema = z.number().int().nonnegative();
const RouteSchema = z.literal("local");

/** aiInvestigationRepository's `COLUMNS` projection. */
export const AiInvestigationSchema = z.looseObject({
  id: z.string(),
  conversationId: z.string().nullable(),
  question: z.string(),
  route: RouteSchema,
  model: z.string().nullable(),
  depth: z.enum(["quick", "detailed"]),
  language: z.enum(["en", "nl"]),
  state: z.string(),
  scope: z.unknown(),
  plan: z.looseObject({}).nullable(),
  checkpoint: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  error: z.unknown(),
  cancelRequestedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/ai-research/investigations/:id` — the job plus its steps. */
export const AiInvestigationDetailSchema = AiInvestigationSchema.extend({
  steps: z.array(
    z.looseObject({
      stepId: z.string(),
      state: z.string(),
      attempt: CountSchema,
      result: z.unknown(),
      error: z.unknown(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
    }),
  ),
});

/** aiResearchDocumentRepository's `DOCUMENT_COLUMNS`. */
export const ResearchDocumentSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  sourceName: z.string(),
  mediaType: z.string(),
  contentSha256: z.string(),
  version: z.number().int().positive(),
  extractionStatus: z.enum(["ready", "failed", "unsupported"]),
  extractionError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/ai-research/documents` — `{items, total}`. */
export const ResearchDocumentListSchema = z.looseObject({
  items: z.array(ResearchDocumentSchema),
  total: CountSchema,
});
