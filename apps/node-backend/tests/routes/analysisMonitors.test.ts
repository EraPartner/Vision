/**
 * Analysis monitor route request validation (ADR-193). The service is mocked;
 * these cases pin what the HTTP boundary accepts before delegating.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/services/analysisMonitorService.ts", () => ({
  checkAnalysisMonitor: vi.fn(),
  createAnalysisMonitor: vi.fn(),
  deleteAnalysisMonitor: vi.fn(),
  listAnalysisMonitors: vi.fn(),
  listMonitorNotifications: vi.fn(),
  listMonitorObservations: vi.fn(),
  patchAnalysisMonitor: vi.fn(),
  readMonitorNotification: vi.fn(),
}));

import {
  checkAnalysisMonitor,
  createAnalysisMonitor,
  deleteAnalysisMonitor,
  listAnalysisMonitors,
  listMonitorNotifications,
  listMonitorObservations,
  patchAnalysisMonitor,
  readMonitorNotification,
} from "../../src/services/analysisMonitorService.ts";

const { default: monitorsRouter } =
  await import("../../src/routes/analysisMonitors.ts");

const api = routeAgent(monitorsRouter, { mountPath: "/api/analysis-monitors" });
const BASE = "/api/analysis-monitors";
const ID = "3f2c7a9e-1b4d-4c8a-9e2f-5a6b7c8d9e0f";

function expectValidationError(res: { body: unknown }, message: RegExp) {
  expect(res.body).toEqual(
    errEnvelope({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(message),
    }),
  );
}

describe("Analysis monitor routes request validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAnalysisMonitors).mockResolvedValue({} as never);
    vi.mocked(listMonitorNotifications).mockResolvedValue({} as never);
    vi.mocked(listMonitorObservations).mockResolvedValue({} as never);
  });

  it("passes coerced pagination to the list services", async () => {
    await api.get(BASE).query({ limit: "25", offset: "50" }).expect(200);
    expect(listAnalysisMonitors).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
    });

    await api.get(`${BASE}/notifications`).expect(200);
    expect(listMonitorNotifications).toHaveBeenCalledWith({});
  });

  it("rejects out-of-range, fractional and repeated pagination", async () => {
    expectValidationError(
      await api.get(BASE).query({ limit: "0" }).expect(400),
      /^limit: /,
    );
    expectValidationError(
      await api
        .get(`${BASE}/notifications`)
        .query({ offset: "1.5" })
        .expect(400),
      /^offset: /,
    );
    expectValidationError(
      await api.get(BASE).query("limit=10&limit=20").expect(400),
      /^limit: /,
    );
    expect(listAnalysisMonitors).not.toHaveBeenCalled();
    expect(listMonitorNotifications).not.toHaveBeenCalled();
  });

  it("accepts a UUID id on every id route", async () => {
    vi.mocked(readMonitorNotification).mockResolvedValue({} as never);
    vi.mocked(checkAnalysisMonitor).mockResolvedValue(null);
    vi.mocked(patchAnalysisMonitor).mockResolvedValue({} as never);
    vi.mocked(deleteAnalysisMonitor).mockResolvedValue(undefined);

    await api.post(`${BASE}/notifications/${ID}/read`).expect(200);
    await api
      .get(`${BASE}/${ID}/observations`)
      .query({ limit: "5" })
      .expect(200);
    await api.post(`${BASE}/${ID}/check`).expect(200);
    await api.patch(`${BASE}/${ID}`).send({ enabled: false }).expect(200);
    await api.delete(`${BASE}/${ID}`).expect(204);

    expect(readMonitorNotification).toHaveBeenCalledWith(ID);
    expect(listMonitorObservations).toHaveBeenCalledWith(ID, { limit: 5 });
    expect(checkAnalysisMonitor).toHaveBeenCalledWith(ID);
    expect(patchAnalysisMonitor).toHaveBeenCalledWith(ID, { enabled: false });
    expect(deleteAnalysisMonitor).toHaveBeenCalledWith(ID);
  });

  it("rejects a non-UUID id before any service call", async () => {
    for (const request of [
      api.post(`${BASE}/notifications/7/read`),
      api.get(`${BASE}/7/observations`),
      api.post(`${BASE}/7/check`),
      api.patch(`${BASE}/7`).send({ enabled: false }),
      api.delete(`${BASE}/7`),
    ]) {
      expectValidationError(await request.expect(400), /^id: /);
    }
    expect(readMonitorNotification).not.toHaveBeenCalled();
    expect(listMonitorObservations).not.toHaveBeenCalled();
    expect(checkAnalysisMonitor).not.toHaveBeenCalled();
    expect(patchAnalysisMonitor).not.toHaveBeenCalled();
    expect(deleteAnalysisMonitor).not.toHaveBeenCalled();
  });

  it("requires a JSON object body for create and patch", async () => {
    vi.mocked(createAnalysisMonitor).mockResolvedValue({} as never);
    const body = { kind: "dossier-evidence", dossierId: ID, title: "Watch" };
    await api.post(BASE).send(body).expect(201);
    expect(createAnalysisMonitor).toHaveBeenCalledWith(body);

    expect(
      (await api.post(BASE).send([body]).expect(400)).body.error.code,
    ).toBe("VALIDATION_ERROR");
    expect((await api.patch(`${BASE}/${ID}`).expect(400)).body.error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(createAnalysisMonitor).toHaveBeenCalledTimes(1);
    expect(patchAnalysisMonitor).not.toHaveBeenCalled();
  });
});
