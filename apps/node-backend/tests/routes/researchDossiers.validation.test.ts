/**
 * Request validation for the research dossier routes (ADR-193). The service is
 * mocked; dossier bodies stay validated by the service's own schemas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/services/researchDossierService.ts", () => ({
  createResearchDossier: vi.fn(),
  deleteResearchDossier: vi.fn(),
  exportResearchDossier: vi.fn(),
  exportResearchDossiers: vi.fn(),
  getResearchDossier: vi.fn(),
  listResearchDossierVersions: vi.fn(),
  listResearchDossiers: vi.fn(),
  restoreResearchDossier: vi.fn(),
  updateResearchDossier: vi.fn(),
}));

import * as rawService from "../../src/services/researchDossierService.ts";

const service = vi.mocked(rawService);
type ListResult = Awaited<ReturnType<typeof rawService.listResearchDossiers>>;

const { default: dossiersRouter } =
  await import("../../src/routes/researchDossiers.ts");

const BASE = "/api/research-dossiers";
const api = routeAgent(dossiersRouter, { mountPath: BASE });
const DOSSIER_ID = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";

describe("Research dossier request validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listResearchDossiers.mockResolvedValue({
      items: [],
      total: 0,
    } as unknown as ListResult);
  });

  it("defaults the page and forwards parsed numbers", async () => {
    await api.get(BASE).expect(200);
    expect(service.listResearchDossiers).toHaveBeenLastCalledWith({
      limit: 100,
      offset: 0,
    });

    await api.get(BASE).query({ limit: "25", offset: "50" }).expect(200);
    expect(service.listResearchDossiers).toHaveBeenLastCalledWith({
      limit: 25,
      offset: 50,
    });
  });

  // `Number(req.query.limit)` used to hand NaN/0/fractions to the service,
  // which answered INVALID_DOSSIER; they are now a route-level 400.
  it.each([
    { limit: "abc" },
    { limit: "" },
    { limit: "1.5" },
    { limit: "501" },
    { offset: "-1" },
    { offset: "x" },
  ])("rejects list query %j", async (query) => {
    const res = await api.get(BASE).query(query).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(service.listResearchDossiers).not.toHaveBeenCalled();
  });

  it.each([
    ["get", "/not-a-uuid"],
    ["get", "/not-a-uuid/export"],
    ["get", "/not-a-uuid/versions"],
    ["post", "/not-a-uuid/restore"],
    ["put", "/not-a-uuid"],
    ["delete", "/not-a-uuid"],
  ] as const)("%s %s rejects a malformed id", async (method, path) => {
    const res = await api[method](`${BASE}${path}`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(service.getResearchDossier).not.toHaveBeenCalled();
    expect(service.exportResearchDossier).not.toHaveBeenCalled();
    expect(service.listResearchDossierVersions).not.toHaveBeenCalled();
    expect(service.restoreResearchDossier).not.toHaveBeenCalled();
    expect(service.updateResearchDossier).not.toHaveBeenCalled();
    expect(service.deleteResearchDossier).not.toHaveBeenCalled();
  });

  it("keeps /export ahead of /:id", async () => {
    service.exportResearchDossiers.mockResolvedValue(
      {} as Awaited<ReturnType<typeof rawService.exportResearchDossiers>>,
    );
    await api.get(`${BASE}/export`).expect(200);
    expect(service.exportResearchDossiers).toHaveBeenCalled();
  });

  it("forwards a valid id", async () => {
    service.getResearchDossier.mockResolvedValue(
      {} as Awaited<ReturnType<typeof rawService.getResearchDossier>>,
    );
    await api.get(`${BASE}/${DOSSIER_ID}`).expect(200);
    expect(service.getResearchDossier).toHaveBeenCalledWith(DOSSIER_ID);
  });
});
