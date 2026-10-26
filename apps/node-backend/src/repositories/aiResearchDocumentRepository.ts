import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import {
  nextVersionRowSchema,
  researchDocumentRowSchema,
  researchPassageRowSchema,
  scoredResearchPassageRowSchema,
} from "../database/rows/ai.ts";
import type {
  ResearchDocumentRow,
  ResearchPassageEmbedding,
  ResearchPassageRow,
  ScoredResearchPassageRow,
} from "../database/rows/ai.ts";

export type {
  ResearchDocumentRow,
  ResearchPassageEmbedding,
  ResearchPassageRow,
  ScoredResearchPassageRow,
};

export type ResearchDocumentInput = {
  title: string;
  sourceName: string;
  mediaType: string;
  contentSha256: string;
  extractionStatus: string;
  extractionError?: string | null;
};

export type ResearchPassageInput = {
  ordinal: number;
  pageNumber?: number | null;
  section?: string | null;
  content: string;
  embedding?: ResearchPassageEmbedding | null;
};

const DOCUMENT_COLUMNS = [
  "id",
  "title",
  "source_name as sourceName",
  "media_type as mediaType",
  "content_sha256 as contentSha256",
  "version",
  "extraction_status as extractionStatus",
  "extraction_error as extractionError",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;

function selectDocuments() {
  return db.selectFrom("ai_research_documents").select(DOCUMENT_COLUMNS);
}

function selectReadyPassages() {
  return db
    .selectFrom("ai_research_passages as p")
    .innerJoin("ai_research_documents as d", "d.id", "p.document_id")
    .select([
      "p.id",
      "p.document_id as documentId",
      "p.ordinal",
      "p.page_number as pageNumber",
      "p.section",
      "p.content",
      "p.embedding_json as embedding",
      "d.title",
      "d.source_name as sourceName",
      "d.version",
      "d.content_sha256 as documentHash",
    ])
    .where("d.extraction_status", "=", "ready");
}

export async function listDocuments(): Promise<ResearchDocumentRow[]> {
  return checkedRows(
    researchDocumentRowSchema,
    selectDocuments().orderBy("updated_at", "desc"),
  );
}

export async function getDocument(
  id: string,
): Promise<ResearchDocumentRow | null> {
  return (
    (await checkedRow(
      researchDocumentRowSchema,
      selectDocuments().where("id", "=", id),
    )) ?? null
  );
}

export async function createDocument(
  input: ResearchDocumentInput,
  passages: ResearchPassageInput[],
): Promise<ResearchDocumentRow> {
  return withTransaction(async () => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-research-document:${input.sourceName}`}))`.execute(
      db,
    );
    const existing = await checkedRow(
      researchDocumentRowSchema,
      selectDocuments()
        .where("source_name", "=", input.sourceName)
        .where("content_sha256", "=", input.contentSha256),
    );
    if (existing) return existing;
    const next = await checkedRow(
      nextVersionRowSchema,
      db
        .selectFrom("ai_research_documents")
        .select(sql<number>`COALESCE(MAX(version),0)+1`.as("version"))
        .where("source_name", "=", input.sourceName),
    );
    // An aggregate without GROUP BY always returns exactly one row.
    if (!next)
      throw new Error("research document version query returned no row");
    const document = await checkedRow(
      researchDocumentRowSchema,
      db
        .insertInto("ai_research_documents")
        .values({
          title: input.title,
          source_name: input.sourceName,
          media_type: input.mediaType,
          content_sha256: input.contentSha256,
          version: next.version,
          extraction_status: input.extractionStatus,
          extraction_error: input.extractionError ?? null,
        })
        .returning(DOCUMENT_COLUMNS),
    );
    if (!document)
      throw new Error("ai_research_documents insert returned no row");
    for (const passage of passages) {
      await db
        .insertInto("ai_research_passages")
        .values({
          document_id: document.id,
          ordinal: passage.ordinal,
          page_number: passage.pageNumber ?? null,
          section: passage.section ?? null,
          content: passage.content,
          embedding_json: passage.embedding
            ? sql<Json>`${JSON.stringify(passage.embedding)}::jsonb`
            : null,
        })
        .execute();
    }
    return document;
  });
}

export async function deleteDocument(id: string): Promise<boolean> {
  const rows = await db
    .deleteFrom("ai_research_documents")
    .where("id", "=", id)
    .returning("id")
    .execute();
  return rows.length > 0;
}

export async function keywordSearch(
  search: string,
  limit: number,
): Promise<ScoredResearchPassageRow[]> {
  const tsquery = sql`websearch_to_tsquery('simple',${search})`;
  // ts_rank_cd() returns REAL, which pg parses to a number.
  return checkedRows(
    scoredResearchPassageRowSchema,
    selectReadyPassages()
      .select(sql<number>`ts_rank_cd(p.search_vector, ${tsquery})`.as("score"))
      .where(sql<boolean>`p.search_vector @@ ${tsquery}`)
      .orderBy("score", "desc")
      .orderBy("d.updated_at", "desc")
      .orderBy("p.ordinal")
      .limit(limit),
  );
}

export async function semanticCandidates(
  limit = 200,
): Promise<ResearchPassageRow[]> {
  return checkedRows(
    researchPassageRowSchema,
    selectReadyPassages()
      .where("p.embedding_json", "is not", null)
      .orderBy("d.updated_at", "desc")
      .orderBy("p.ordinal")
      .limit(limit),
  );
}
