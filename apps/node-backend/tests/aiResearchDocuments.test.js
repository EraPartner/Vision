import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  createDocument: vi.fn(),
  keywordSearch: vi.fn(),
  semanticCandidates: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock(
  "../src/repositories/aiResearchDocumentRepository.js",
  () => repository,
);
import {
  __extractDocument,
  ingestResearchDocument,
  searchResearchDocuments,
} from "../src/services/aiResearchDocuments.js";

describe("local research documents", () => {
  beforeEach(() => vi.clearAllMocks());
  it("preserves Markdown sections in cited passages and reports unsupported scans", () => {
    expect(
      __extractDocument(Buffer.from("# Risks\nEvidence text"), "text/markdown")
        .passages[0],
    ).toMatchObject({ section: "Risks", content: "Evidence text" });
    expect(
      __extractDocument(Buffer.from("pdf"), "application/pdf"),
    ).toMatchObject({ status: "unsupported", passages: [] });
  });
  it("batches optional local embeddings and stores only derived passages", async () => {
    repository.createDocument.mockImplementation(async (doc, passages) => ({
      ...doc,
      passages,
    }));
    const embed = vi.fn(async ({ input }) => ({
      model: "synthetic-embed",
      embeddings: input.map(() => [1, 0]),
    }));
    const text = Array.from(
      { length: 70 },
      (_, index) => `# S${index}\n${"x".repeat(1000)}`,
    ).join("\n");
    const result = await ingestResearchDocument(
      {
        title: "Report",
        sourceName: "report.md",
        mediaType: "text/markdown",
        buffer: Buffer.from(text),
      },
      { ollamaClient: { embed } },
    );
    expect(embed.mock.calls.length).toBeGreaterThan(1);
    expect(result.passages[0].embedding.model).toBe("synthetic-embed");
  });
  it("falls back visibly to keyword retrieval when semantic search is unavailable", async () => {
    repository.keywordSearch.mockResolvedValue([
      {
        id: "p",
        documentId: "d",
        version: 1,
        ordinal: 0,
        title: "Report",
        sourceName: "r.md",
        documentHash: "a".repeat(64),
        pageNumber: null,
        section: "Summary",
        content: "Evidence",
        score: 0.7,
      },
    ]);
    const result = await searchResearchDocuments(
      { query: "evidence", mode: "hybrid" },
      {
        ollamaClient: {
          embed: async () => {
            throw new Error("offline");
          },
        },
      },
    );
    expect(result.meta).toMatchObject({
      semanticStatus: "unavailable",
      partial: true,
    });
    expect(result.passages[0].locator).toBeUndefined();
  });
});
