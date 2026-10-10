import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
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

const DOCUMENT_COLUMNS = `id, title, source_name AS "sourceName", media_type AS "mediaType",
  content_sha256 AS "contentSha256", version, extraction_status AS "extractionStatus",
  extraction_error AS "extractionError", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listDocuments(): Promise<ResearchDocumentRow[]> {
  return queryRows(
    researchDocumentRowSchema,
    `SELECT ${DOCUMENT_COLUMNS} FROM ai_research_documents ORDER BY updated_at DESC`,
  );
}

export async function getDocument(
  id: string,
): Promise<ResearchDocumentRow | null> {
  return (
    (await queryOne(
      researchDocumentRowSchema,
      `SELECT ${DOCUMENT_COLUMNS} FROM ai_research_documents WHERE id=$1`,
      [id],
    )) ?? null
  );
}

export async function createDocument(
  input: ResearchDocumentInput,
  passages: ResearchPassageInput[],
): Promise<ResearchDocumentRow> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `ai-research-document:${input.sourceName}`,
    ]);
    const existing = await queryOne(
      researchDocumentRowSchema,
      `SELECT ${DOCUMENT_COLUMNS} FROM ai_research_documents
       WHERE source_name=$1 AND content_sha256=$2`,
      [input.sourceName, input.contentSha256],
      client,
    );
    if (existing) return existing;
    const next = await queryOne(
      nextVersionRowSchema,
      "SELECT COALESCE(MAX(version),0)+1 AS version FROM ai_research_documents WHERE source_name=$1",
      [input.sourceName],
      client,
    );
    // An aggregate without GROUP BY always returns exactly one row.
    if (!next)
      throw new Error("research document version query returned no row");
    const document = await queryOne(
      researchDocumentRowSchema,
      `INSERT INTO ai_research_documents
        (title,source_name,media_type,content_sha256,version,extraction_status,extraction_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${DOCUMENT_COLUMNS}`,
      [
        input.title,
        input.sourceName,
        input.mediaType,
        input.contentSha256,
        Number(next.version),
        input.extractionStatus,
        input.extractionError ?? null,
      ],
      client,
    );
    if (!document)
      throw new Error("ai_research_documents insert returned no row");
    for (const passage of passages) {
      await client.query(
        `INSERT INTO ai_research_passages
          (document_id,ordinal,page_number,section,content,embedding_json)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          document.id,
          passage.ordinal,
          passage.pageNumber ?? null,
          passage.section ?? null,
          passage.content,
          passage.embedding ? JSON.stringify(passage.embedding) : null,
        ],
      );
    }
    return document;
  });
}

export async function deleteDocument(id: string): Promise<boolean> {
  const result = await query(
    "DELETE FROM ai_research_documents WHERE id=$1 RETURNING id",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function keywordSearch(
  search: string,
  limit: number,
): Promise<ScoredResearchPassageRow[]> {
  // ts_rank_cd() returns REAL, which pg parses to a number.
  return queryRows(
    scoredResearchPassageRowSchema,
    `SELECT p.id, p.document_id AS "documentId", p.ordinal,
            p.page_number AS "pageNumber", p.section, p.content,
            p.embedding_json AS embedding, d.title, d.source_name AS "sourceName",
            d.version, d.content_sha256 AS "documentHash",
            ts_rank_cd(p.search_vector, websearch_to_tsquery('simple',$1)) AS score
       FROM ai_research_passages p
       JOIN ai_research_documents d ON d.id=p.document_id
      WHERE d.extraction_status='ready'
        AND p.search_vector @@ websearch_to_tsquery('simple',$1)
      ORDER BY score DESC, d.updated_at DESC, p.ordinal
      LIMIT $2`,
    [search, limit],
  );
}

export async function semanticCandidates(
  limit = 200,
): Promise<ResearchPassageRow[]> {
  return queryRows(
    researchPassageRowSchema,
    `SELECT p.id, p.document_id AS "documentId", p.ordinal,
            p.page_number AS "pageNumber", p.section, p.content,
            p.embedding_json AS embedding, d.title, d.source_name AS "sourceName",
            d.version, d.content_sha256 AS "documentHash"
       FROM ai_research_passages p
       JOIN ai_research_documents d ON d.id=p.document_id
      WHERE d.extraction_status='ready' AND p.embedding_json IS NOT NULL
      ORDER BY d.updated_at DESC, p.ordinal LIMIT $1`,
    [limit],
  );
}
