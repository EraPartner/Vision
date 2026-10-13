import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";

const fixture = vi.hoisted(() => ({
  result: {
    detected: null,
    detectionError: null,
    preview: { headers: ["Date"], rows: [] },
    previewError: null,
    separator: ",",
  },
  probe: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportProbe.ts", () => ({
  probePortfolioImport: fixture.probe,
}));
vi.mock("../../src/lib/csvUpload.ts", () => ({ cleanup: fixture.cleanup }));
vi.mock("../../src/lib/portfolioUpload.ts", () => ({
  portfolioUpload: {
    single: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
vi.mock("../../src/config/logger.ts", async () => {
  const { mockLogger } = await import("../helpers/mockLogger.ts");
  return { logger: mockLogger() };
});
const { registerPortfolioImportProbeRoute } =
  await import("../../src/routes/portfolioImportProbeRoutes.ts");
const router = Router();
registerPortfolioImportProbeRoute(router);
const api = routeAgent(router, {
  mountPath: "/api/portfolio/import",
  before: [
    (req: Request, _res: Response, next: NextFunction) => {
      if (req.query.noFile !== "true")
        req.file = {
          path: "/tmp/synthetic-probe",
          originalname: "synthetic.csv",
        } as Express.Multer.File;
      next();
    },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  fixture.probe.mockResolvedValue(fixture.result);
});
describe("portfolio import read-only probe boundary", () => {
  it("returns the normal envelope and default options without invoking batch routes", async () => {
    const response = await api
      .post("/api/portfolio/import/probe")
      .send({})
      .expect(200);
    expect(bodyAt(response, "ok")).toBe(true);
    expect(bodyAt(response, "data")).toEqual(fixture.result);
    expect(fixture.probe).toHaveBeenCalledWith(
      "/tmp/synthetic-probe",
      "synthetic.csv",
      { encoding: "utf-8", skipRows: 0 },
    );
    expect(fixture.cleanup).toHaveBeenCalledExactlyOnceWith(
      "/tmp/synthetic-probe",
    );
  });
  it("passes validated pinned delimiter, encoding and skipped rows", async () => {
    await api
      .post("/api/portfolio/import/probe")
      .send({ separator: ";", encoding: "latin1", skipRows: "2" })
      .expect(200);
    expect(fixture.probe).toHaveBeenCalledWith(
      "/tmp/synthetic-probe",
      "synthetic.csv",
      { separator: ";", encoding: "latin1", skipRows: 2 },
    );
  });
  it.each(["ISO-8859-1", "latin-1", "LATIN1"])(
    "normalizes existing parser encoding alias %s",
    async (encoding) => {
      await api
        .post("/api/portfolio/import/probe")
        .send({ encoding })
        .expect(200);
      expect(fixture.probe).toHaveBeenCalledWith(
        "/tmp/synthetic-probe",
        "synthetic.csv",
        { encoding: "latin1", skipRows: 0 },
      );
    },
  );
  it.each([
    { separator: "xx" },
    { encoding: "utf-16" },
    { skipRows: "1e3" },
    { skipRows: "-1" },
  ])("rejects invalid options and cleans up %j", async (body) => {
    await api.post("/api/portfolio/import/probe").send(body).expect(400);
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.cleanup).toHaveBeenCalledExactlyOnceWith(
      "/tmp/synthetic-probe",
    );
  });
  it("cleans up on an unknown read failure", async () => {
    fixture.probe.mockRejectedValueOnce(new Error("Synthetic read failure"));
    await api.post("/api/portfolio/import/probe").send({}).expect(500);
    expect(fixture.cleanup).toHaveBeenCalledExactlyOnceWith(
      "/tmp/synthetic-probe",
    );
  });
  it("rejects missing files before probing", async () => {
    await api
      .post("/api/portfolio/import/probe?noFile=true")
      .send({})
      .expect(400);
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
  });
});
