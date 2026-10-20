/**
 * Request validation for the AI research routes (ADR-193): bodies and ids are
 * parsed with parseInput, so failures are 400 VALIDATION_ERROR envelopes whose
 * issues carry their field path. Services are mocked.
 */
import { bodyAt } from "../helpers/responseBody.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/services/aiInvestigationService.ts", () => ({
  createInvestigation: vi.fn(),
  listInvestigations: vi.fn(),
  getInvestigation: vi.fn(),
  cancelInvestigation: vi.fn(),
  deleteInvestigation: vi.fn(),
  resumeInvestigation: vi.fn(),
}));
import {
  getInvestigation as rawGetInvestigation,
  resumeInvestigation as rawResumeInvestigation,
} from "../../src/services/aiInvestigationService.ts";

const getInvestigation = vi.mocked(rawGetInvestigation);
const resumeInvestigation = vi.mocked(rawResumeInvestigation);

const { default: aiResearchRouter } =
  await import("../../src/routes/aiResearch.ts");

const BASE = "/api/ai-research";
const api = routeAgent(aiResearchRouter, { mountPath: BASE });
const JOB_ID = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";

describe("AI research request validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed investigation id before the service", async () => {
    const res = await api.get(`${BASE}/investigations/123`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(getInvestigation).not.toHaveBeenCalled();
  });

  it("POST /investigations/:id/resume rejects unknown keys and accepts no body", async () => {
    const res = await api
      .post(`${BASE}/investigations/${JOB_ID}/resume`)
      .send({ clarification: "more", extra: true })
      .expect(400);
    expect(bodyAt(res, "error", "code")).toBe("VALIDATION_ERROR");
    expect(resumeInvestigation).not.toHaveBeenCalled();

    resumeInvestigation.mockResolvedValue(
      {} as Awaited<ReturnType<typeof rawResumeInvestigation>>,
    );
    await api.post(`${BASE}/investigations/${JOB_ID}/resume`).expect(202);
    expect(resumeInvestigation).toHaveBeenCalledWith(
      JOB_ID,
      undefined,
      undefined,
    );
  });
});
