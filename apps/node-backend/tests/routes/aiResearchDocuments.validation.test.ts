/**
 * Request validation for the local research document routes (ADR-193).
 *
 * The service functions are mocked: these tests pin what the router accepts
 * and forwards, not ingestion or retrieval.
 */
import { bodyAt } from "../helpers/responseBody.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/services/aiResearchDocuments.ts", () => ({
  deleteResearchDocument: vi.fn(),
  getResearchDocument: vi.fn(),
  ingestResearchDocument: vi.fn(),
  listResearchDocuments: vi.fn(),
  searchResearchDocuments: vi.fn(),
}));

import {
  getResearchDocument as rawGetResearchDocument,
  ingestResearchDocument as rawIngestResearchDocument,
} from "../../src/services/aiResearchDocuments.ts";

const getResearchDocument = vi.mocked(rawGetResearchDocument);
const ingestResearchDocument = vi.mocked(rawIngestResearchDocument);

type IngestResult = Awaited<ReturnType<typeof rawIngestResearchDocument>>;

const { default: documentsRouter } =
  await import("../../src/routes/aiResearchDocuments.ts");

const BASE = "/api/ai-research/documents";
const api = routeAgent(documentsRouter, { mountPath: BASE });
const DOC_ID = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";

describe("AI research document request validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed document id before the service", async () => {
    const res = await api.get(`${BASE}/not-a-uuid`).expect(400);
    expect(res.body).toEqual(
      errEnvelope({
        code: "VALIDATION_ERROR",
        message: "Invalid research document id",
      }),
    );
    expect(getResearchDocument).not.toHaveBeenCalled();
  });

  it("falls back to the file name for blank multipart fields", async () => {
    ingestResearchDocument.mockResolvedValue({ id: DOC_ID } as IngestResult);
    await api
      .post(BASE)
      .field("title", "")
      .attach("file", Buffer.from("# Notes"), {
        filename: "notes.md",
        contentType: "text/markdown",
      })
      .expect(201);
    expect(ingestResearchDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: "notes.md", sourceName: "notes.md" }),
    );
  });

  it("rejects a repeated title field", async () => {
    const res = await api
      .post(BASE)
      .field("title", "one")
      .field("title", "two")
      .attach("file", Buffer.from("# Notes"), {
        filename: "notes.md",
        contentType: "text/markdown",
      })
      .expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(bodyAt(res, "error", "message")).toMatch(/^title: /);
    expect(ingestResearchDocument).not.toHaveBeenCalled();
  });
});
