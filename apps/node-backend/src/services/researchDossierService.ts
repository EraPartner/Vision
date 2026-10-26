/** Local, versioned research dossiers. Never sends content to a provider. */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { asCategoryId, asInvestmentId } from "@vision/types/brands";
import type { CategoryId, InvestmentId } from "@vision/types/brands";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import { intTotalRowSchema } from "../database/rows/ai.ts";
import {
  researchDossierDocumentRowSchema,
  researchDossierLinkLabelRowSchema,
  researchDossierLinkRowSchema,
  researchDossierRowSchema,
  researchDossierSnapshotRowSchema,
  researchDossierSummaryRowSchema,
  researchDossierUnavailableLinkRowSchema,
  researchDossierVersionRowSchema,
} from "../database/rows/analysis.ts";
import type { ResearchDossierRow } from "../database/rows/analysis.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Invalid calendar date");
const nonempty = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().max(max).default("");
const sourceSchema = z
  .object({
    title: nonempty(500),
    reference: nonempty(2000),
    sourceDate: date.nullable().default(null),
    accessedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    documentId: z.uuid().optional(),
    documentVersion: z.number().int().positive().optional(),
    passageOrdinal: z.number().int().nonnegative().optional(),
    contentSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.documentVersion !== undefined ||
        value.passageOrdinal !== undefined ||
        value.contentSha256 !== undefined) &&
      !value.documentId
    ) {
      context.addIssue({
        code: "custom",
        message: "Document metadata requires documentId",
      });
    }
  });
const evidenceSchema = z
  .object({
    id: z.uuid().optional(),
    stance: z.enum(["support", "oppose", "context"]),
    origin: z.enum(["user", "ai-draft"]),
    claim: nonempty(8000),
    source: sourceSchema,
    notes: optionalText(8000),
  })
  .strict();
const dossierContentSchema = z
  .object({
    title: nonempty(300),
    workspace: z.enum([
      "budgeting",
      "portfolio",
      "research",
      "cross-workspace",
    ]),
    question: nonempty(8000),
    userThesis: optionalText(16000),
    assumptions: z.array(nonempty(2000)).max(50).default([]),
    openQuestions: z.array(nonempty(2000)).max(50).default([]),
    conclusion: optionalText(16000),
    reviewDate: date.nullable().default(null),
    evidence: z.array(evidenceSchema).max(30).default([]),
    links: z
      .object({
        categoryIds: z.array(z.number().int().positive()).max(100).default([]),
        investmentIds: z
          .array(z.number().int().positive())
          .max(100)
          .default([]),
        savedAnalysisIds: z.array(nonempty(100)).max(100).default([]),
      })
      .strict()
      .default({ categoryIds: [], investmentIds: [], savedAnalysisIds: [] }),
  })
  .strict();
const uuid = z.uuid();
const versionNumber = z.number().int().positive();

export type DossierContent = z.output<typeof dossierContentSchema>;

type DossierRow = ResearchDossierRow;

type LiveLink =
  | { category_id: CategoryId }
  | { investment_id: InvestmentId }
  | { saved_analysis_id: string };

interface ResolvedLink {
  kind: string;
  ordinal: number;
  historicalId: string;
  label: string;
  live: LiveLink;
}

function jsonb(value: unknown) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
      { code: "INVALID_DOSSIER" },
    );
  }
  return result.data;
}

function normalizeContent(input: unknown): DossierContent {
  const content = parse(dossierContentSchema, input);
  const evidenceIds = new Set<string>();
  content.evidence = content.evidence.map((item) => {
    const id = item.id ?? randomUUID();
    if (evidenceIds.has(id))
      throw new ValidationError("Duplicate evidence id", {
        code: "INVALID_DOSSIER",
      });
    evidenceIds.add(id);
    return { ...item, id };
  });
  for (const ids of Object.values(content.links)) {
    if (new Set<number | string>(ids).size !== ids.length) {
      throw new ValidationError("Duplicate dossier link", {
        code: "INVALID_DOSSIER",
      });
    }
  }
  return content;
}

async function validateDocuments(
  content: DossierContent,
  // Stored content predates some fields, so `evidence` may be absent.
  previousContent?: Partial<DossierContent>,
) {
  for (const evidence of content.evidence) {
    const source = evidence.source;
    if (!source.documentId) continue;
    // A saved citation is a provenance snapshot, not a live document pointer.
    // Keep it editable after source deletion or re-extraction if unchanged.
    const previouslySaved = previousContent?.evidence?.some(
      (item) =>
        item.id === evidence.id && isDeepStrictEqual(item.source, source),
    );
    if (previouslySaved) continue;
    const document = await checkedRow(
      researchDossierDocumentRowSchema,
      db
        .selectFrom("ai_research_documents")
        .select(["id", "title", "version", "content_sha256"])
        .where("id", "=", source.documentId),
    );
    if (!document) {
      throw new ValidationError(
        "Document source is unavailable; only an unchanged saved citation may be retained",
        {
          code: "DOSSIER_SOURCE_MISMATCH",
        },
      );
    }
    if (
      (source.documentVersion !== undefined &&
        source.documentVersion !== document.version) ||
      (source.contentSha256 !== undefined &&
        source.contentSha256 !== document.content_sha256) ||
      (source.passageOrdinal !== undefined &&
        (
          await db
            .selectFrom("ai_research_passages")
            .select(sql<number>`1`.as("found"))
            .where("document_id", "=", source.documentId)
            .where("ordinal", "=", source.passageOrdinal)
            .execute()
        ).length === 0)
    ) {
      throw new ValidationError(
        "Document source no longer matches its saved version, digest, or passage",
        {
          code: "DOSSIER_SOURCE_MISMATCH",
        },
      );
    }
    // Pin provenance at save time. The snapshot remains useful after document deletion.
    source.documentVersion = document.version;
    source.contentSha256 = document.content_sha256;
  }
}

async function resolvedLinks(content: DossierContent) {
  const entries: ResolvedLink[] = [];
  const definitions: Array<
    [
      kind: string,
      ids: Array<number | string>,
      lookup: (id: number | string) => Promise<{ label: unknown } | undefined>,
      live: (id: number | string) => LiveLink,
    ]
  > = [
    [
      "category",
      content.links.categoryIds,
      (id) =>
        checkedRow(
          researchDossierLinkLabelRowSchema,
          db
            .selectFrom("categories")
            .select("path_name as label")
            .where("id", "=", asCategoryId(Number(id))),
        ),
      (id) => ({ category_id: asCategoryId(Number(id)) }),
    ],
    [
      "investment",
      content.links.investmentIds,
      (id) =>
        checkedRow(
          researchDossierLinkLabelRowSchema,
          db
            .selectFrom("investments")
            .select("name as label")
            .where("id", "=", asInvestmentId(Number(id))),
        ),
      (id) => ({ investment_id: asInvestmentId(Number(id)) }),
    ],
    [
      "saved-analysis",
      content.links.savedAnalysisIds,
      (id) =>
        checkedRow(
          researchDossierLinkLabelRowSchema,
          db
            .selectFrom("saved_analyses")
            .select("name as label")
            .where("id", "=", String(id)),
        ),
      (id) => ({ saved_analysis_id: String(id) }),
    ],
  ];
  for (const [kind, ids, lookup, live] of definitions) {
    for (const [ordinal, id] of ids.entries()) {
      const label = await lookup(id);
      if (!label) {
        throw new ValidationError(`Unknown ${kind} link: ${id}`, {
          code: "INVALID_DOSSIER_LINK",
        });
      }
      entries.push({
        kind,
        ordinal,
        historicalId: String(id),
        label: String(label.label),
        live: live(id),
      });
    }
  }
  return entries;
}

async function replaceLinks(id: string, entries: ResolvedLink[]) {
  const unavailable = await checkedRows(
    researchDossierUnavailableLinkRowSchema,
    db
      .selectFrom("research_dossier_links")
      .select(["link_type", "historical_id", "label_snapshot"])
      .where("dossier_id", "=", id)
      .where("category_id", "is", null)
      .where("investment_id", "is", null)
      .where("saved_analysis_id", "is", null)
      .orderBy("link_type")
      .orderBy("ordinal"),
  );
  await db
    .deleteFrom("research_dossier_links")
    .where("dossier_id", "=", id)
    .execute();
  for (const entry of entries) {
    await db
      .insertInto("research_dossier_links")
      .values({
        dossier_id: id,
        link_type: entry.kind,
        ordinal: entry.ordinal,
        historical_id: entry.historicalId,
        label_snapshot: entry.label,
        ...entry.live,
      })
      .execute();
  }
  const nextOrdinal = new Map<string, number>();
  for (const entry of entries) nextOrdinal.set(entry.kind, entry.ordinal + 1);
  for (const link of unavailable) {
    const ordinal = nextOrdinal.get(link.link_type) ?? 0;
    nextOrdinal.set(link.link_type, ordinal + 1);
    await db
      .insertInto("research_dossier_links")
      .values({
        dossier_id: id,
        link_type: link.link_type,
        ordinal,
        historical_id: link.historical_id,
        label_snapshot: link.label_snapshot,
      })
      .execute();
  }
}

async function hydrate(row: DossierRow) {
  const rows = await checkedRows(
    researchDossierLinkRowSchema,
    db
      .selectFrom("research_dossier_links")
      .select([
        "link_type",
        "historical_id",
        "label_snapshot",
        "category_id",
        "investment_id",
        "saved_analysis_id",
      ])
      .where("dossier_id", "=", row.id)
      .orderBy("link_type")
      .orderBy("ordinal"),
  );
  const content = row.content_json;
  const links: DossierContent["links"] = {
    categoryIds: [],
    investmentIds: [],
    savedAnalysisIds: [],
  };
  const seenLive = new Set<string>();
  const linkDetails = rows.map((link) => {
    const liveId =
      link.category_id ?? link.investment_id ?? link.saved_analysis_id;
    const liveKey = `${link.link_type}:${liveId}`;
    if (liveId !== null && !seenLive.has(liveKey)) {
      seenLive.add(liveKey);
      if (link.link_type === "category") links.categoryIds.push(Number(liveId));
      else if (link.link_type === "investment")
        links.investmentIds.push(Number(liveId));
      else links.savedAnalysisIds.push(String(liveId));
    }
    return {
      kind: link.link_type,
      historicalId: link.historical_id,
      labelSnapshot: link.label_snapshot,
      liveId,
      status: liveId === null ? "deleted" : "live",
    };
  });
  return {
    id: row.id,
    version: row.version,
    ...content,
    links,
    linkDetails,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function getRow(id: string, lock = false): Promise<DossierRow> {
  const builder = db
    .selectFrom("research_dossiers")
    .selectAll()
    .where("id", "=", parse(uuid, id));
  const row = await checkedRow(
    researchDossierRowSchema,
    lock ? builder.forUpdate() : builder,
  );
  if (!row)
    throw new NotFoundError("Research dossier not found", {
      code: "DOSSIER_NOT_FOUND",
    });
  return row;
}

export async function listResearchDossiers({
  limit = 100,
  offset = 0,
}: { limit?: number; offset?: number } = {}) {
  const paging = parse(
    z.object({
      limit: z.number().int().min(1).max(500),
      offset: z.number().int().nonnegative(),
    }),
    { limit, offset },
  );
  const [rows, count] = await Promise.all([
    checkedRows(
      researchDossierSummaryRowSchema,
      db
        .selectFrom("research_dossiers")
        .select([
          "id",
          "version",
          "workspace",
          "title",
          sql<string | null>`content_json->>'question'`.as("question"),
          sql<string | null>`content_json->>'reviewDate'`.as("review_date"),
          "created_at",
          "updated_at",
        ])
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .limit(paging.limit)
        .offset(paging.offset),
    ),
    checkedRow(
      intTotalRowSchema,
      db
        .selectFrom("research_dossiers")
        .select(sql<number>`count(*)::int`.as("total")),
    ),
  ]);
  // An aggregate without GROUP BY always returns exactly one row.
  if (!count) throw new Error("count(*) returned no row");
  return {
    items: rows.map((row) => ({
      id: row.id,
      version: row.version,
      workspace: row.workspace,
      title: row.title,
      question: row.question,
      reviewDate: row.review_date,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })),
    total: count.total,
    limit: paging.limit,
    offset: paging.offset,
  };
}

export async function getResearchDossier(id: string) {
  return hydrate(await getRow(id));
}

export async function createResearchDossier(input: unknown) {
  const content = normalizeContent(input);
  return withTransaction(async () => {
    await validateDocuments(content);
    const links = await resolvedLinks(content);
    const id = randomUUID();
    const created = await checkedRow(
      researchDossierRowSchema,
      db
        .insertInto("research_dossiers")
        .values({
          id,
          workspace: content.workspace,
          title: content.title,
          content_json: jsonb(content),
        })
        .returningAll(),
    );
    if (!created) throw new Error("research_dossiers insert returned no row");
    await db
      .insertInto("research_dossier_versions")
      .values({ dossier_id: id, version: 1, snapshot_json: jsonb(content) })
      .execute();
    await replaceLinks(id, links);
    return hydrate(created);
  });
}

async function writeVersion(
  id: string,
  expectedVersion: number,
  content: DossierContent,
) {
  parse(versionNumber, expectedVersion);
  return withTransaction(async () => {
    const current = await getRow(id, true);
    if (current.version !== expectedVersion) {
      throw new ConflictError("Dossier version changed; reload before saving", {
        code: "DOSSIER_VERSION_CONFLICT",
      });
    }
    await validateDocuments(content, current.content_json);
    const links = await resolvedLinks(content);
    // The row is locked above, so the UPDATE matches it.
    const updated = await checkedRow(
      researchDossierRowSchema,
      db
        .updateTable("research_dossiers")
        .set((eb) => ({
          version: eb("version", "+", 1),
          workspace: content.workspace,
          title: content.title,
          content_json: jsonb(content),
          updated_at: sql<Date>`now()`,
        }))
        .where("id", "=", current.id)
        .returningAll(),
    );
    if (!updated) throw new Error("research_dossiers update returned no row");
    await db
      .insertInto("research_dossier_versions")
      .values({
        dossier_id: id,
        version: updated.version,
        snapshot_json: jsonb(content),
      })
      .execute();
    await replaceLinks(id, links);
    return hydrate(updated);
  });
}

export async function updateResearchDossier(id: string, input: unknown) {
  const parsed = parse(
    dossierContentSchema.extend({ expectedVersion: versionNumber }),
    input,
  );
  const { expectedVersion, ...content } = parsed;
  return writeVersion(id, expectedVersion, normalizeContent(content));
}

export async function listResearchDossierVersions(id: string) {
  await getRow(id);
  const rows = await checkedRows(
    researchDossierVersionRowSchema,
    db
      .selectFrom("research_dossier_versions")
      .select(["version", "snapshot_json", "created_at"])
      .where("dossier_id", "=", id)
      .orderBy("version", "desc"),
  );
  return {
    items: rows.map((row) => ({
      version: row.version,
      snapshot: row.snapshot_json,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function restoreResearchDossier(id: string, input: unknown) {
  const { version, expectedVersion } = parse(
    z
      .object({ version: versionNumber, expectedVersion: versionNumber })
      .strict(),
    input,
  );
  const snapshot = await checkedRow(
    researchDossierSnapshotRowSchema,
    db
      .selectFrom("research_dossier_versions")
      .select("snapshot_json")
      .where("dossier_id", "=", parse(uuid, id))
      .where("version", "=", version),
  );
  if (!snapshot)
    throw new NotFoundError("Dossier version not found", {
      code: "DOSSIER_VERSION_NOT_FOUND",
    });
  return writeVersion(
    id,
    expectedVersion,
    normalizeContent(snapshot.snapshot_json),
  );
}

export async function deleteResearchDossier(id: string) {
  const { numDeletedRows } = await db
    .deleteFrom("research_dossiers")
    .where("id", "=", parse(uuid, id))
    .executeTakeFirst();
  if (numDeletedRows === 0n)
    throw new NotFoundError("Research dossier not found", {
      code: "DOSSIER_NOT_FOUND",
    });
}

export async function exportResearchDossier(id: string) {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dossiers: [
      {
        ...(await getResearchDossier(id)),
        versions: (await listResearchDossierVersions(id)).items,
      },
    ],
  };
}

export async function exportResearchDossiers() {
  const rows = await checkedRows(
    researchDossierRowSchema,
    db
      .selectFrom("research_dossiers")
      .selectAll()
      .orderBy("created_at")
      .orderBy("id"),
  );
  const items = await Promise.all(rows.map(hydrate));
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dossiers: await Promise.all(
      items.map(async (item) => ({
        ...item,
        versions: (await listResearchDossierVersions(item.id)).items,
      })),
    ),
  };
}

export {
  dossierContentSchema as __dossierContentSchema,
};
