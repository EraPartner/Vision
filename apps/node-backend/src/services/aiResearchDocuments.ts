import { createHash } from "node:crypto";
import { getOllamaClient } from "../integrations/ollama/client.ts";
import * as repository from "../repositories/aiResearchDocumentRepository.ts";
import type {
  ResearchPassageInput,
  ResearchPassageRow,
} from "../repositories/aiResearchDocumentRepository.ts";

type OllamaClient = ReturnType<typeof getOllamaClient>;

export interface ExtractedDocument {
  status: "unsupported" | "failed" | "ready";
  error: string | null;
  passages: ResearchPassageInput[];
}

export interface ResearchDocumentCitation {
  id: string;
  kind: "document";
  title: string;
  sourceName: string;
  documentId: string;
  documentVersion: number;
  documentHash: string;
  passageId: string;
  passageOrdinal: number;
  pageNumber: number | null;
  section: string | null;
  text: string;
  score: number;
  retrieval: "keyword" | "semantic" | "hybrid";
  trust: "untrusted-evidence";
}

const SUPPORTED_TYPES = new Set(["text/plain", "text/markdown", "text/html"]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PASSAGES = 512;
const TARGET_CHARS = 1800;
const EMBEDDING_BATCH_SIZE = 16;
let embeddingTail: Promise<unknown> = Promise.resolve([]);

// `&amp;` is decoded last, so an escaped entity such as `&amp;lt;` stays the literal `&lt;`.
function cleanHtml(value: string) {
  return value
    .replace(/<(script|style|noscript|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function decodeUtf8(buffer: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (text.includes("\u0000")) throw new Error("Document contains binary data");
  return text.replace(/\r\n?/g, "\n");
}

function extractDocument(buffer: Buffer, mediaType: string): ExtractedDocument {
  if (!SUPPORTED_TYPES.has(mediaType)) {
    return {
      status: "unsupported",
      error:
        mediaType === "application/pdf"
          ? "PDF extraction is not installed. Export a text or Markdown copy; scanned PDFs require OCR."
          : `Unsupported document type: ${mediaType}`,
      passages: [],
    };
  }
  let text: string;
  try {
    text = decodeUtf8(buffer);
    if (mediaType === "text/html") text = cleanHtml(text);
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      passages: [],
    };
  }
  const lines = text.split("\n");
  const passages: ResearchPassageInput[] = [];
  let section: string | null = null;
  let pending = "";
  const flush = () => {
    const content = pending.replace(/\s+/g, " ").trim();
    if (content)
      passages.push({
        ordinal: passages.length,
        pageNumber: null,
        section,
        content,
      });
    pending = "";
  };
  for (const raw of lines) {
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/)?.[1];
    if (heading !== undefined) {
      flush();
      section = heading.trim().slice(0, 500);
      continue;
    }
    const line = raw.trim();
    if (!line) {
      if (pending.length >= TARGET_CHARS / 2) flush();
      continue;
    }
    if (pending.length + line.length + 1 > TARGET_CHARS) flush();
    pending += `${pending ? " " : ""}${line}`;
    if (passages.length >= MAX_PASSAGES) break;
  }
  flush();
  if (!passages.length)
    return {
      status: "failed",
      error: "No readable text was extracted",
      passages: [],
    };
  return {
    status: "ready",
    error: null,
    passages: passages.slice(0, MAX_PASSAGES),
  };
}

async function addEmbeddings(
  passages: ResearchPassageInput[],
  ollamaClient: Pick<OllamaClient, "embed">,
): Promise<ResearchPassageInput[]> {
  const task = embeddingTail
    .catch(() => {})
    .then(async () => {
      const embedded: ResearchPassageInput[] = [];
      for (
        let index = 0;
        index < passages.length;
        index += EMBEDDING_BATCH_SIZE
      ) {
        const batch = passages.slice(index, index + EMBEDDING_BATCH_SIZE);
        const result = await ollamaClient.embed({
          input: batch.map((item) => item.content),
        });
        embedded.push(
          ...batch.map((passage, offset) => {
            // embed() rejects a response without one vector per input.
            const vector = result.embeddings[offset];
            if (!vector) throw new Error("Ollama returned too few embeddings");
            return { ...passage, embedding: { model: result.model, vector } };
          }),
        );
      }
      return embedded;
    });
  embeddingTail = task;
  try {
    return await task;
  } catch {
    return passages;
  }
}

/** `title`, `sourceName` and `buffer` arrive from multipart input and are checked here. */
export async function ingestResearchDocument(
  {
    title,
    sourceName,
    mediaType,
    buffer,
  }: {
    title: unknown;
    sourceName: unknown;
    mediaType: string;
    buffer: unknown;
  },
  { ollamaClient = getOllamaClient() }: { ollamaClient?: OllamaClient } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    throw new Error("A non-empty document is required");
  if (buffer.length > MAX_BYTES)
    throw new Error("Research documents are limited to 5 MiB");
  if (typeof title !== "string" || !title.trim())
    throw new Error("Document title is required");
  if (typeof sourceName !== "string" || !sourceName.trim())
    throw new Error("Source name is required");
  const extracted = extractDocument(buffer, mediaType);
  const passages =
    extracted.status === "ready"
      ? await addEmbeddings(extracted.passages, ollamaClient)
      : [];
  return repository.createDocument(
    {
      title: title.trim(),
      sourceName: sourceName.trim(),
      mediaType,
      contentSha256: createHash("sha256").update(buffer).digest("hex"),
      extractionStatus: extracted.status,
      extractionError: extracted.error,
    },
    passages,
  );
}

function cosine(a: number[] | undefined, b: number[] | undefined) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== b.length ||
    !a.length
  )
    return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    // Both vectors have the same length (checked above).
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

function cite(
  row: ResearchPassageRow,
  score: number,
  retrieval: ResearchDocumentCitation["retrieval"],
): ResearchDocumentCitation {
  return {
    id: `document:${row.documentId}:v${row.version}:p${row.ordinal}`,
    kind: "document",
    title: row.title,
    sourceName: row.sourceName,
    documentId: row.documentId,
    documentVersion: Number(row.version),
    documentHash: row.documentHash,
    passageId: row.id,
    passageOrdinal: Number(row.ordinal),
    pageNumber: row.pageNumber,
    section: row.section,
    text: row.content,
    score,
    retrieval,
    trust: "untrusted-evidence",
  };
}

export async function searchResearchDocuments(
  {
    query: search,
    mode = "hybrid",
    limit = 8,
  }: { query?: string; mode?: string; limit?: number },
  {
    ollamaClient = getOllamaClient(),
    signal,
  }: { ollamaClient?: OllamaClient; signal?: AbortSignal } = {},
) {
  const normalized = String(search || "").trim();
  if (!normalized) throw new Error("Search query is required");
  const boundedLimit = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const keyword =
    mode === "semantic"
      ? []
      : await repository.keywordSearch(normalized, boundedLimit * 2);
  let semantic: Array<{ row: ResearchPassageRow; score: number }> = [];
  let semanticStatus = mode === "keyword" ? "not-requested" : "unavailable";
  if (mode !== "keyword") {
    try {
      const embedded = await ollamaClient.embed({
        input: [normalized],
        signal,
      });
      const candidates = await repository.semanticCandidates();
      semantic = candidates
        .filter((row) => row.embedding?.model === embedded.model)
        .map((row) => ({
          row,
          score: cosine(embedded.embeddings[0], row.embedding?.vector),
        }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, boundedLimit * 2);
      semanticStatus = semantic.length ? "available" : "unavailable";
    } catch (error) {
      if (signal?.aborted) throw error;
      semanticStatus = "unavailable";
    }
  }
  const merged = new Map<string, ResearchDocumentCitation>();
  keyword.forEach((row) =>
    merged.set(row.id, cite(row, Number(row.score), "keyword")),
  );
  semantic.forEach(({ row, score }) => {
    const existing = merged.get(row.id);
    merged.set(
      row.id,
      cite(
        row,
        existing ? Math.max(existing.score, score) : score,
        existing ? "hybrid" : "semantic",
      ),
    );
  });
  return {
    passages: [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, boundedLimit),
    meta: {
      mode,
      semanticStatus,
      partial: mode !== "keyword" && semanticStatus !== "available",
    },
  };
}

export const listResearchDocuments = repository.listDocuments;
export const getResearchDocument = repository.getDocument;
export const deleteResearchDocument = repository.deleteDocument;
export { extractDocument as __extractDocument };
