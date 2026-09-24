/** Local, versioned research dossiers. Never sends content to a provider. */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { query, withTransaction } from "../database/connection.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.js";

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
const nonempty = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) => z.string().max(max).default("");
const sourceSchema = z
  .object({
    title: nonempty(500),
    reference: nonempty(2000),
    sourceDate: date.nullable().default(null),
    accessedAt: z.string().datetime({ offset: true }).nullable().default(null),
    documentId: z.string().uuid().optional(),
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
    id: z.string().uuid().optional(),
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
const uuid = z.string().uuid();
const versionNumber = z.number().int().positive();

function parse(schema, input) {
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

function normalizeContent(input) {
  const content = parse(dossierContentSchema, input);
  const evidenceIds = new Set();
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
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError("Duplicate dossier link", {
        code: "INVALID_DOSSIER",
      });
    }
  }
  return content;
}

async function validateDocuments(content, previousContent) {
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
    const { rows } = await query(
      `SELECT id,title,version,content_sha256 FROM ai_research_documents WHERE id=$1`,
      [source.documentId],
    );
    const document = rows[0];
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
        !(
          await query(
            `SELECT 1 FROM ai_research_passages WHERE document_id=$1 AND ordinal=$2`,
            [source.documentId, source.passageOrdinal],
          )
        ).rows.length)
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

async function resolvedLinks(content) {
  const entries = [];
  const definitions = [
    [
      "category",
      content.links.categoryIds,
      "categories",
      "path_name",
      "category_id",
    ],
    [
      "investment",
      content.links.investmentIds,
      "investments",
      "name",
      "investment_id",
    ],
    [
      "saved-analysis",
      content.links.savedAnalysisIds,
      "saved_analyses",
      "name",
      "saved_analysis_id",
    ],
  ];
  for (const [kind, ids, table, labelColumn, liveColumn] of definitions) {
    for (let ordinal = 0; ordinal < ids.length; ordinal += 1) {
      const id = ids[ordinal];
      const { rows } = await query(
        `SELECT ${labelColumn} AS label FROM ${table} WHERE id=$1`,
        [id],
      );
      if (!rows.length) {
        throw new ValidationError(`Unknown ${kind} link: ${id}`, {
          code: "INVALID_DOSSIER_LINK",
        });
      }
      entries.push({
        kind,
        ordinal,
        historicalId: String(id),
        label: String(rows[0].label),
        liveColumn,
        id,
      });
    }
  }
  return entries;
}

async function replaceLinks(id, entries) {
  const { rows: unavailable } = await query(
    `SELECT link_type,historical_id,label_snapshot FROM research_dossier_links
     WHERE dossier_id=$1 AND category_id IS NULL AND investment_id IS NULL
       AND saved_analysis_id IS NULL ORDER BY link_type,ordinal`,
    [id],
  );
  await query(`DELETE FROM research_dossier_links WHERE dossier_id=$1`, [id]);
  for (const entry of entries) {
    await query(
      `INSERT INTO research_dossier_links
       (dossier_id,link_type,ordinal,historical_id,label_snapshot,${entry.liveColumn})
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        entry.kind,
        entry.ordinal,
        entry.historicalId,
        entry.label,
        entry.id,
      ],
    );
  }
  const nextOrdinal = new Map();
  for (const entry of entries) nextOrdinal.set(entry.kind, entry.ordinal + 1);
  for (const link of unavailable) {
    const ordinal = nextOrdinal.get(link.link_type) ?? 0;
    nextOrdinal.set(link.link_type, ordinal + 1);
    await query(
      `INSERT INTO research_dossier_links
       (dossier_id,link_type,ordinal,historical_id,label_snapshot)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, link.link_type, ordinal, link.historical_id, link.label_snapshot],
    );
  }
}

async function hydrate(row) {
  const { rows } = await query(
    `SELECT link_type,historical_id,label_snapshot,category_id,investment_id,saved_analysis_id
     FROM research_dossier_links WHERE dossier_id=$1 ORDER BY link_type,ordinal`,
    [row.id],
  );
  const content = row.content_json;
  const links = { categoryIds: [], investmentIds: [], savedAnalysisIds: [] };
  const seenLive = new Set();
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

async function getRow(id, lock = false) {
  const { rows } = await query(
    `SELECT * FROM research_dossiers WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [parse(uuid, id)],
  );
  if (!rows.length)
    throw new NotFoundError("Research dossier not found", {
      code: "DOSSIER_NOT_FOUND",
    });
  return rows[0];
}

export async function listResearchDossiers({ limit = 100, offset = 0 } = {}) {
  const paging = parse(
    z.object({
      limit: z.number().int().min(1).max(500),
      offset: z.number().int().nonnegative(),
    }),
    { limit, offset },
  );
  const [{ rows }, count] = await Promise.all([
    query(
      `SELECT id,version,workspace,title,content_json->>'question' AS question,
              content_json->>'reviewDate' AS review_date,created_at,updated_at
       FROM research_dossiers ORDER BY updated_at DESC,id DESC LIMIT $1 OFFSET $2`,
      [paging.limit, paging.offset],
    ),
    query(`SELECT count(*)::int AS total FROM research_dossiers`),
  ]);
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
    total: count.rows[0].total,
    limit: paging.limit,
    offset: paging.offset,
  };
}

export async function getResearchDossier(id) {
  return hydrate(await getRow(id));
}

export async function createResearchDossier(input) {
  const content = normalizeContent(input);
  return withTransaction(async () => {
    await validateDocuments(content);
    const links = await resolvedLinks(content);
    const id = randomUUID();
    const { rows } = await query(
      `INSERT INTO research_dossiers (id,workspace,title,content_json)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [id, content.workspace, content.title, JSON.stringify(content)],
    );
    await query(
      `INSERT INTO research_dossier_versions (dossier_id,version,snapshot_json)
                 VALUES ($1,1,$2::jsonb)`,
      [id, JSON.stringify(content)],
    );
    await replaceLinks(id, links);
    return hydrate(rows[0]);
  });
}

async function writeVersion(id, expectedVersion, content) {
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
    const { rows } = await query(
      `UPDATE research_dossiers SET version=version+1,workspace=$2,title=$3,
       content_json=$4::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
      [current.id, content.workspace, content.title, JSON.stringify(content)],
    );
    await query(
      `INSERT INTO research_dossier_versions (dossier_id,version,snapshot_json)
                 VALUES ($1,$2,$3::jsonb)`,
      [id, rows[0].version, JSON.stringify(content)],
    );
    await replaceLinks(id, links);
    return hydrate(rows[0]);
  });
}

export async function updateResearchDossier(id, input) {
  const parsed = parse(
    dossierContentSchema.extend({ expectedVersion: versionNumber }),
    input,
  );
  const { expectedVersion, ...content } = parsed;
  return writeVersion(id, expectedVersion, normalizeContent(content));
}

export async function listResearchDossierVersions(id) {
  await getRow(id);
  const { rows } = await query(
    `SELECT version,snapshot_json,created_at FROM research_dossier_versions
     WHERE dossier_id=$1 ORDER BY version DESC`,
    [id],
  );
  return {
    items: rows.map((row) => ({
      version: row.version,
      snapshot: row.snapshot_json,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function restoreResearchDossier(id, input) {
  const { version, expectedVersion } = parse(
    z
      .object({ version: versionNumber, expectedVersion: versionNumber })
      .strict(),
    input,
  );
  const { rows } = await query(
    `SELECT snapshot_json FROM research_dossier_versions WHERE dossier_id=$1 AND version=$2`,
    [parse(uuid, id), version],
  );
  if (!rows.length)
    throw new NotFoundError("Dossier version not found", {
      code: "DOSSIER_VERSION_NOT_FOUND",
    });
  return writeVersion(
    id,
    expectedVersion,
    normalizeContent(rows[0].snapshot_json),
  );
}

export async function deleteResearchDossier(id) {
  const { rowCount } = await query(
    `DELETE FROM research_dossiers WHERE id=$1`,
    [parse(uuid, id)],
  );
  if (!rowCount)
    throw new NotFoundError("Research dossier not found", {
      code: "DOSSIER_NOT_FOUND",
    });
}

export async function exportResearchDossier(id) {
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
  const { rows } = await query(
    `SELECT * FROM research_dossiers ORDER BY created_at,id`,
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
