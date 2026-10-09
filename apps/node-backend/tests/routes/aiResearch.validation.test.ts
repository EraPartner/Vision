/**
 * Request validation for the AI research routes (ADR-193): bodies and ids are
 * parsed with parseInput, so failures are 400 VALIDATION_ERROR envelopes whose
 * issues carry their field path. Services are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/services/agentCloakDesktopSetupService.ts", () => ({
  agentCloakDesktopStatus: vi.fn(),
  configureAgentCloakDesktop: vi.fn(),
}));
vi.mock("../../src/services/aiInvestigationService.ts", () => ({
  createInvestigation: vi.fn(),
  listInvestigations: vi.fn(),
  getInvestigation: vi.fn(),
  cancelInvestigation: vi.fn(),
  deleteInvestigation: vi.fn(),
  resumeInvestigation: vi.fn(),
}));
vi.mock("../../src/services/aiDisclosureService.ts", () => ({
  createDisclosureGrant: vi.fn(),
  listDisclosureGrants: vi.fn(),
  listDisclosureRecords: vi.fn(),
  revokeDisclosureGrant: vi.fn(),
  deleteDisclosureHistory: vi.fn(),
}));

import { configureAgentCloakDesktop as rawConfigure } from "../../src/services/agentCloakDesktopSetupService.ts";
import {
  getInvestigation as rawGetInvestigation,
  resumeInvestigation as rawResumeInvestigation,
} from "../../src/services/aiInvestigationService.ts";
import { revokeDisclosureGrant as rawRevokeDisclosureGrant } from "../../src/services/aiDisclosureService.ts";

const configureAgentCloakDesktop = vi.mocked(rawConfigure);
const getInvestigation = vi.mocked(rawGetInvestigation);
const resumeInvestigation = vi.mocked(rawResumeInvestigation);
const revokeDisclosureGrant = vi.mocked(rawRevokeDisclosureGrant);

const { default: aiResearchRouter } =
  await import("../../src/routes/aiResearch.ts");

const BASE = "/api/ai-research";
const api = routeAgent(aiResearchRouter, { mountPath: BASE });
const JOB_ID = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";

describe("AI research request validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PUT /agentcloak-desktop rejects a non-boolean flag with its path", async () => {
    const res = await api
      .put(`${BASE}/agentcloak-desktop`)
      .send({ enabled: "yes" })
      .expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(res.body.error.message).toMatch(/^enabled: /);
    expect(configureAgentCloakDesktop).not.toHaveBeenCalled();
  });

  it("rejects a malformed investigation id before the service", async () => {
    const res = await api.get(`${BASE}/investigations/123`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(getInvestigation).not.toHaveBeenCalled();
  });

  it("rejects a malformed disclosure grant id", async () => {
    await api.post(`${BASE}/disclosures/grants/nope/revoke`).expect(400);
    expect(revokeDisclosureGrant).not.toHaveBeenCalled();
  });

  it("POST /investigations/:id/resume rejects unknown keys and accepts no body", async () => {
    const res = await api
      .post(`${BASE}/investigations/${JOB_ID}/resume`)
      .send({ clarification: "more", extra: true })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
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
