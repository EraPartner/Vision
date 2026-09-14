import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const { client } = vi.hoisted(() => ({ client: { query: vi.fn() } }));

vi.mock("../src/database/connection.js", () => mockTxConnection(client));

import { query, withTransaction } from "../src/database/connection.js";
import {
  clearProviderResult,
  createJob,
} from "../src/repositories/aiInvestigationRepository.js";

const request = {
  conversationId: null,
  question: "Compare the selected evidence",
  route: "openai-api",
  model: "test-model",
  depth: "quick",
  language: "en",
  scope: {},
  researchMode: "local-only",
  publicQuestion: null,
  publicWebQuery: null,
  publicSymbols: [],
  publicMacroQueries: [],
  clarification: null,
  selectedSummary: "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]",
  selectedEvidence: null,
  referenceScopeId: "11111111-1111-4111-8111-111111111111",
  savedAnalysisId: null,
  grantId: "22222222-2222-4222-8222-222222222222",
};

describe("aiInvestigationRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the job and claims its reference scope in one transaction", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: "job-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: request.referenceScopeId }] });

    await expect(
      createJob(request, "2026-10-14T00:00:00.000Z"),
    ).resolves.toEqual({ id: "job-1" });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain(
      "WHERE id=$1 AND job_id IS NULL AND expires_at > NOW()",
    );
    expect(client.query.mock.calls[1][1]).toEqual([
      request.referenceScopeId,
      "job-1",
      "2026-10-14T00:00:00.000Z",
    ]);
  });

  it("aborts job creation when the scope cannot be claimed", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: "job-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      createJob(request, "2026-10-14T00:00:00.000Z"),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_INACTIVE", status: 409 });
  });

  it("clears a stale provider checkpoint before an explicit retry", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "job-1" }] });

    await expect(clearProviderResult("job-1")).resolves.toEqual({
      id: "job-1",
    });
    expect(query.mock.calls[0][0]).toContain(
      "checkpoint_json=checkpoint_json - 'providerResult'",
    );
  });
});
