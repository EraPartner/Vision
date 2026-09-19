import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/database/connection.js", () =>
  mockTxConnection({ query: mockQuery }, { query: mockQuery }),
);

import {
  createResearchDossier,
  dossierContentSchema,
  exportResearchDossiers,
  getResearchDossier,
  listResearchDossiers,
  updateResearchDossier,
} from "../src/services/researchDossierService.js";

const id = "00000000-0000-4000-8000-000000000001";
const content = {
  title: "A research question",
  workspace: "research",
  question: "What changed?",
  userThesis: "Maybe demand",
  assumptions: [],
  openQuestions: [],
  conclusion: "",
  reviewDate: null,
  evidence: [],
  links: { categoryIds: [], investmentIds: [], savedAnalysisIds: [] },
};
const row = {
  id,
  version: 1,
  content_json: content,
  created_at: new Date("2026-09-19T00:00:00Z"),
  updated_at: new Date("2026-09-19T00:00:00Z"),
};

beforeEach(() => mockQuery.mockReset());

describe("research dossier persistence", () => {
  it("rejects unknown fields and invalid evidence provenance", () => {
    expect(
      dossierContentSchema.safeParse({ ...content, secret: "x" }).success,
    ).toBe(false);
    expect(
      dossierContentSchema.safeParse({
        ...content,
        evidence: [
          {
            stance: "support",
            origin: "ai-draft",
            claim: "Claim",
            source: { title: "Doc", reference: "page 1", documentVersion: 1 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("writes current data and immutable version in one transaction", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...row }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const created = await createResearchDossier(content);
    expect(created.version).toBe(1);
    expect(
      mockQuery.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO research_dossier_versions"),
      ),
    ).toBe(true);
    expect(
      mockQuery.mock.calls.some(([sql]) =>
        sql.includes("DELETE FROM research_dossier_links"),
      ),
    ).toBe(true);
  });

  it("does not advertise deleted links as live selections", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({
      rows: [
        {
          link_type: "category",
          historical_id: "17",
          label_snapshot: "FOOD:OLD",
          category_id: null,
          investment_id: null,
          saved_analysis_id: null,
        },
      ],
    });
    const dossier = await getResearchDossier(id);
    expect(dossier.links.categoryIds).toEqual([]);
    expect(dossier.linkDetails).toEqual([
      expect.objectContaining({
        historicalId: "17",
        status: "deleted",
        labelSnapshot: "FOOD:OLD",
      }),
    ]);
  });

  it("hydrates a category merge target while preserving the old label", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({
      rows: [
        {
          link_type: "category",
          historical_id: "17",
          label_snapshot: "FOOD:OLD",
          category_id: 27,
          investment_id: null,
          saved_analysis_id: null,
        },
      ],
    });
    const dossier = await getResearchDossier(id);
    expect(dossier.links.categoryIds).toEqual([27]);
    expect(dossier.linkDetails[0]).toMatchObject({
      historicalId: "17",
      liveId: 27,
    });
  });

  it("deduplicates live selections after source and target links merge", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({
      rows: [
        {
          link_type: "category",
          historical_id: "17",
          label_snapshot: "FOOD:OLD",
          category_id: 27,
          investment_id: null,
          saved_analysis_id: null,
        },
        {
          link_type: "category",
          historical_id: "27",
          label_snapshot: "FOOD:NEW",
          category_id: 27,
          investment_id: null,
          saved_analysis_id: null,
        },
      ],
    });
    const dossier = await getResearchDossier(id);
    expect(dossier.links.categoryIds).toEqual([27]);
    expect(dossier.linkDetails).toHaveLength(2);
  });

  it("keeps an unchanged cited document and deleted-link tombstone through an edit", async () => {
    const evidenceId = "00000000-0000-4000-8000-000000000002";
    const source = {
      title: "Removed document",
      reference: "page 2",
      sourceDate: null,
      accessedAt: null,
      documentId: "00000000-0000-4000-8000-000000000003",
      documentVersion: 1,
      contentSha256: "a".repeat(64),
    };
    const prior = {
      ...content,
      evidence: [
        {
          id: evidenceId,
          stance: "oppose",
          origin: "ai-draft",
          claim: "Contrary evidence",
          source,
          notes: "",
        },
      ],
    };
    const tombstone = {
      link_type: "investment",
      historical_id: "9",
      label_snapshot: "Sold stock",
    };
    mockQuery.mockImplementation(async (sql) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("FROM ai_research_documents"))
        throw new Error("Unchanged source was queried");
      if (
        sql.includes("FROM research_dossiers WHERE id=") &&
        sql.includes("FOR UPDATE")
      )
        return { rows: [{ ...row, content_json: prior }] };
      if (sql.includes("UPDATE research_dossiers"))
        return { rows: [{ ...row, version: 2, content_json: prior }] };
      if (sql.includes("WHERE dossier_id=$1 AND category_id IS NULL"))
        return { rows: [tombstone] };
      if (sql.includes("FROM research_dossier_links"))
        return {
          rows: [
            {
              ...tombstone,
              category_id: null,
              investment_id: null,
              saved_analysis_id: null,
            },
          ],
        };
      return { rows: [] };
    });
    const updated = await updateResearchDossier(id, {
      ...prior,
      conclusion: "Revised",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(
      mockQuery.mock.calls.some(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO research_dossier_links") &&
          sql.includes("label_snapshot)"),
      ),
    ).toBe(true);
  });

  it("rejects a stale expected version before writing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, version: 2 }] });
    await expect(
      updateResearchDossier(id, { ...content, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "DOSSIER_VERSION_CONFLICT" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("exports beyond the first page", async () => {
    const many = Array.from({ length: 501 }, (_, index) => ({
      ...row,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    mockQuery.mockImplementation(async (sql) => {
      if (typeof sql !== "string") return { rows: [] };
      if (sql.includes("FROM research_dossiers ORDER BY created_at"))
        return { rows: many };
      if (sql.includes("FROM research_dossier_links")) return { rows: [] };
      if (sql.includes("FROM research_dossiers WHERE id="))
        return { rows: [row] };
      if (sql.includes("FROM research_dossier_versions")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const exported = await exportResearchDossiers();
    expect(exported.dossiers).toHaveLength(501);
  });

  it("lists summaries without loading private evidence or links", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id,
            version: 1,
            workspace: "research",
            title: content.title,
            question: content.question,
            review_date: null,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const listed = await listResearchDossiers();
    expect(listed.items).toEqual([
      expect.objectContaining({
        id,
        title: content.title,
        question: content.question,
      }),
    ]);
    expect(listed.items[0]).not.toHaveProperty("evidence");
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).not.toContain("SELECT *");
  });
});
