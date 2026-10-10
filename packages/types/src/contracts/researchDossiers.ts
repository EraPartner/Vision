import { z } from "zod";

/*
 * Wire contracts for /api/research-dossiers (services/researchDossierService).
 * Stored content and version snapshots are written through the service's
 * normalizeContent, so every content key is present (defaults applied).
 */

const CountSchema = z.number().int().nonnegative();
const DayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DossierWorkspaceSchema = z.enum([
  "budgeting",
  "portfolio",
  "research",
  "cross-workspace",
]);

const DossierEvidenceSchema = z.looseObject({
  id: z.string(),
  stance: z.enum(["support", "oppose", "context"]),
  origin: z.enum(["user", "ai-draft"]),
  claim: z.string(),
  source: z.looseObject({
    title: z.string(),
    reference: z.string(),
    sourceDate: DayStringSchema.nullable(),
    accessedAt: z.string().nullable(),
    documentId: z.string().optional(),
    documentVersion: z.number().int().positive().optional(),
    passageOrdinal: CountSchema.optional(),
    contentSha256: z.string().optional(),
  }),
  notes: z.string(),
});

/** The normalized dossier content (also a version's `snapshot`). */
export const DossierContentSchema = z.looseObject({
  title: z.string(),
  workspace: DossierWorkspaceSchema,
  question: z.string(),
  userThesis: z.string(),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  conclusion: z.string(),
  reviewDate: DayStringSchema.nullable(),
  evidence: z.array(DossierEvidenceSchema),
  links: z.looseObject({
    categoryIds: z.array(z.number().int().positive()),
    investmentIds: z.array(z.number().int().positive()),
    savedAnalysisIds: z.array(z.string()),
  }),
});

/** A hydrated dossier (GET/POST/PUT `/:id`, restore). */
export const DossierSchema = DossierContentSchema.extend({
  id: z.string(),
  version: z.number().int().positive(),
  linkDetails: z.array(
    z.looseObject({
      kind: z.enum(["category", "investment", "saved-analysis"]),
      historicalId: z.string(),
      labelSnapshot: z.string(),
      liveId: z.union([z.number(), z.string()]).nullable(),
      status: z.enum(["live", "deleted"]),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * `GET /api/research-dossiers` — `{items, total, limit, offset}`. `question`
 * and `reviewDate` are read with `content_json->>`, so they are nullable.
 */
export const DossierListSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      id: z.string(),
      version: z.number().int().positive(),
      workspace: DossierWorkspaceSchema,
      title: z.string(),
      question: z.string().nullable(),
      reviewDate: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  total: CountSchema,
  limit: z.number().int().positive(),
  offset: CountSchema,
});

const DossierVersionSchema = z.looseObject({
  version: z.number().int().positive(),
  snapshot: DossierContentSchema,
  createdAt: z.string(),
});

/** `GET /api/research-dossiers/:id/versions` — `{items}`. */
export const DossierVersionListSchema = z.looseObject({
  items: z.array(DossierVersionSchema),
});

/** `GET /api/research-dossiers/export` and `/:id/export`. */
export const DossierExportSchema = z.looseObject({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  dossiers: z.array(
    DossierSchema.extend({ versions: z.array(DossierVersionSchema) }),
  ),
});
