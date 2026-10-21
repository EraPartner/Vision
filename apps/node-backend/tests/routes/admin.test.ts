/**
 * Admin route tests.
 * Mirrors: apps/backend/tests/test_admin.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.ts). The production admin mount
 * (`mountRouter(app, '/api/admin', adminRateLimiter, adminCsrfGuard,
 * adminRouter)` in main.ts) is reproduced by the harness. `adminRateLimiter`
 * (app-level, module-scoped counters) and `adminCsrfGuard` (redundant with the
 * harness's own global CSRF mount, see routeApp.ts fidelity map) are
 * intentionally not added again here.
 * `adminMutateLimiter`, declared INSIDE admin.js on individual mutate routes,
 * is exercised for free since the real router is mounted.
 */
import { bodyAt, valueAt } from "../helpers/responseBody.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockLogger } from "../helpers/mockLogger.ts";
import { routeAgent, okEnvelope, errEnvelope } from "../helpers/routeApp.ts";
import { mockConnection } from "../helpers/repoMocks.ts";

vi.mock("https", () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock("../../src/database/connection.ts", () =>
  mockConnection({
    checkConnection: vi.fn(),
    getTableCount: vi.fn(),
    getClient: vi.fn(),
    query: vi.fn(),
  }),
);

const settings = vi.hoisted(() => ({
  admin: { enableResetDb: false },
  isDevelopment: () => true,
}));

vi.mock("../../src/config/config.ts", () => ({ default: settings }));

vi.mock("../../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

vi.mock("../../src/services/priceProviderService.ts", () => ({
  sanitizePersistedKinesisHistory: vi.fn(),
}));

vi.mock("../../src/services/providerHealthService.ts", () => ({
  listProviderHealth: vi.fn(),
  probeProvider: vi.fn(),
}));

vi.mock("../../src/services/routeManifest.ts", () => ({
  getRouteManifest: vi.fn(),
}));

import {
  checkConnection as rawCheckConnection,
  getTableCount as rawGetTableCount,
} from "../../src/database/connection.ts";
import { sanitizePersistedKinesisHistory as rawSanitizePersistedKinesisHistory } from "../../src/services/priceProviderService.ts";
import { listProviderHealth as rawListProviderHealth } from "../../src/services/providerHealthService.ts";
import { getRouteManifest as rawGetRouteManifest } from "../../src/services/routeManifest.ts";
import https from "https";

const checkConnection = vi.mocked(rawCheckConnection);
const getTableCount = vi.mocked(rawGetTableCount);
const sanitizePersistedKinesisHistory = vi.mocked(
  rawSanitizePersistedKinesisHistory,
);
const listProviderHealth = vi.mocked(rawListProviderHealth);
const getRouteManifest = vi.mocked(rawGetRouteManifest);

const { default: adminRouter } = await import("../../src/routes/admin.ts");

const api = routeAgent(adminRouter, { mountPath: "/api/admin" });
const BASE = "/api/admin";

describe("Admin Routes", () => {
  const initialAppVersion = process.env.APP_VERSION;

  beforeEach(() => {
    vi.clearAllMocks();
    settings.admin.enableResetDb = false;
    delete process.env.APP_VERSION;
  });

  afterEach(() => {
    if (initialAppVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = initialAppVersion;
    }
  });

  describe("GET /", () => {
    it("should return status when connected", async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      const res = await api.get(`${BASE}/`).expect(200);

      const result = bodyAt(res, "data");
      expect(valueAt(result, "is_initialised")).toBe(true);
      expect(valueAt(result, "table_count")).toBe(5);
      expect(valueAt(result, "timestamp")).toBeDefined();
    });

    it("should report uninitialised with no tables", async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(0);

      const res = await api.get(`${BASE}/`).expect(200);

      expect(bodyAt(res, "data", "is_initialised")).toBe(false);
    });

    it("should report uninitialised when disconnected", async () => {
      checkConnection.mockResolvedValue(false);

      const res = await api.get(`${BASE}/`).expect(200);

      expect(bodyAt(res, "data", "is_initialised")).toBe(false);
      expect(bodyAt(res, "data", "table_count")).toBe(0);
    });

    it("should propagate errors when connection fails", async () => {
      checkConnection.mockRejectedValue(new Error("Connection failed"));

      const res = await api.get(`${BASE}/`).expect(500);
      expect(bodyAt(res, "error", "message")).toBe("Connection failed");
    });
  });

  describe("POST /database/init", () => {
    it("should verify connection successfully", async () => {
      checkConnection.mockResolvedValue(true);

      const res = await api.post(`${BASE}/database/init`).expect(201);

      expect(res.body).toEqual(expect.objectContaining({ ok: true }));
    });

    it("should throw AppError when cannot connect", async () => {
      checkConnection.mockResolvedValue(false);

      const res = await api.post(`${BASE}/database/init`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({
          code: "APP_ERROR",
          message: "Cannot connect to database",
        }),
      );
    });

    it("should propagate errors when init check throws", async () => {
      checkConnection.mockRejectedValue(new Error("driver stack trace"));

      const res = await api.post(`${BASE}/database/init`).expect(500);
      expect(bodyAt(res, "error", "message")).toBe("driver stack trace");
    });
  });

  describe("POST /database/reset", () => {
    it("should throw NotFoundError when reset disabled", async () => {
      settings.admin.enableResetDb = false;

      const res = await api.post(`${BASE}/database/reset`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("should throw ValidationError without force parameter", async () => {
      settings.admin.enableResetDb = true;

      const res = await api.post(`${BASE}/database/reset`).expect(400);
      expect(res.body).toEqual(
        errEnvelope({
          code: "VALIDATION_ERROR",
          message: "Database reset requires force=true in the request body",
          details: {
            hint: "Set force=true in the JSON request body to confirm reset (DESTRUCTIVE)",
          },
        }),
      );
    });

    it("accepts force=true in the request body", async () => {
      settings.admin.enableResetDb = true;

      const res = await api
        .post(`${BASE}/database/reset`)
        .send({ force: true })
        .expect(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true }));
    });

    it("rejects query-only force confirmation", async () => {
      settings.admin.enableResetDb = true;

      await api.post(`${BASE}/database/reset?force=true`).expect(400);
    });

    it("ignores the query parameter when the body confirms reset", async () => {
      settings.admin.enableResetDb = true;

      await api
        .post(`${BASE}/database/reset?force=false`)
        .send({ force: true })
        .expect(200);
    });

    it("rejects string force values in the JSON body", async () => {
      settings.admin.enableResetDb = true;

      await api
        .post(`${BASE}/database/reset`)
        .send({ force: "true" })
        .expect(400);
    });
  });

  describe("GET /update/check", () => {
    it("should return update metadata when latest release exists", async () => {
      mockGitHubReleaseBody(
        JSON.stringify({
          tag_name: "v1.2.3",
          published_at: "2026-04-01T12:00:00Z",
          body: "Release notes",
          html_url: "https://github.com/EraPartner/Vision/releases/tag/v1.2.3",
        }),
      );

      const res = await api.get(`${BASE}/update/check`).expect(200);

      const payload = bodyAt(res, "data");
      expect(valueAt(payload, "latest_version")).toBe("v1.2.3");
      expect(valueAt(payload, "published_at")).toBe("2026-04-01T12:00:00Z");
      expect(valueAt(payload, "release_notes")).toBe("Release notes");
      expect(valueAt(payload, "html_url")).toBe(
        "https://github.com/EraPartner/Vision/releases/tag/v1.2.3",
      );
      expect(payload).toHaveProperty("up_to_date");
      expect(payload).toHaveProperty("current_version");
    });

    it("should report source update mode for HTTP clients", async () => {
      // Inside the desktop shell the frontend short-circuits to the Electron
      // IPC updater, so anything hitting this route is a source deployment.
      mockGitHubReleaseBody(JSON.stringify({ tag_name: "v9.9.9" }));

      const res = await api.get(`${BASE}/update/check`).expect(200);

      expect(bodyAt(res, "data", "update_mode")).toBe("source");
    });

    it("should include version metadata in update check response", async () => {
      mockGitHubReleaseBody(JSON.stringify({ tag_name: "v2.1.0" }));

      const res = await api.get(`${BASE}/update/check`).expect(200);

      const payload = bodyAt(res, "data");
      expect(valueAt(payload, "latest_version")).toBe("v2.1.0");
      expect(payload).toHaveProperty("current_version");
      expect(payload).toHaveProperty("up_to_date");
    });

    it("should return no-release payload when GitHub returns not found", async () => {
      mockGitHubReleaseBody(JSON.stringify({ message: "Not Found" }));

      const res = await api.get(`${BASE}/update/check`).expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          up_to_date: true,
          current_version: "unknown",
          error: "No published releases found",
          latest_version: null,
          update_mode: "source",
        }),
      );
    });

    it("should return no-release payload when GitHub returns a null JSON body", async () => {
      mockGitHubReleaseBody("null");

      const res = await api.get(`${BASE}/update/check`).expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          up_to_date: true,
          current_version: "unknown",
          error: "No published releases found",
          latest_version: null,
          update_mode: "source",
        }),
      );
    });

    it("should propagate error when release payload is invalid json", async () => {
      mockGitHubReleaseBody("{ invalid-json");

      const res = await api.get(`${BASE}/update/check`).expect(500);
      expect(bodyAt(res, "error", "code")).toBe("INTERNAL_SERVER_ERROR");
    });
  });

  describe("POST /update/apply", () => {
    it("should return update acknowledgement payload", async () => {
      const res = await api.post(`${BASE}/update/apply`).expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          success: true,
          note: "Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.",
        }),
      );
    });
  });

  describe("POST /update/apply-and-restart", () => {
    it("should return backwards compatible update acknowledgement payload", async () => {
      const res = await api
        .post(`${BASE}/update/apply-and-restart`)
        .expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          success: true,
          note: "Updates are managed by the Vision desktop app for the active runtime provider. No manual action is required.",
        }),
      );
    });
  });

  describe("POST /investments/kinesis/sanitize-history", () => {
    it("should sanitize persisted kinesis history and return summary", async () => {
      sanitizePersistedKinesisHistory.mockResolvedValue({
        processed: 3,
        updated: 2,
        correctedPoints: 4,
        failed: 0,
      });

      const res = await api
        .post(`${BASE}/investments/kinesis/sanitize-history`)
        .expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          message: "Kinesis historical spikes sanitization completed",
          processed: 3,
          updated: 2,
          correctedPoints: 4,
          failed: 0,
        }),
      );
    });

    it("should propagate error when sanitization fails", async () => {
      sanitizePersistedKinesisHistory.mockRejectedValue(new Error("boom"));

      const res = await api
        .post(`${BASE}/investments/kinesis/sanitize-history`)
        .expect(500);
      expect(bodyAt(res, "error", "message")).toBe("boom");
    });
  });

  // The three admin collection GETs used to answer with a bare array as `data`.
  // They now use the canonical `{ items, total }` collection body (unpaginated,
  // so `total` is the row count).
  describe("collection response shape", () => {
    it("GET /providers/health returns { items, total }", async () => {
      const providers = [
        { provider: "yahoo", kind: "price" },
        { provider: "ecb", kind: "fx" },
      ];
      listProviderHealth.mockResolvedValue(
        providers as Awaited<ReturnType<typeof rawListProviderHealth>>,
      );

      const res = await api.get(`${BASE}/providers/health`).expect(200);

      expect(res.body).toEqual(okEnvelope({ items: providers, total: 2 }));
    });

    it("GET /endpoints returns { items, total }", async () => {
      const manifest = [{ method: "GET", path: "/api/health" }];
      getRouteManifest.mockReturnValue(manifest);

      const res = await api.get(`${BASE}/endpoints`).expect(200);

      expect(res.body).toEqual(okEnvelope({ items: manifest, total: 1 }));
    });

    it("GET /endpoints reports total 0 for an empty manifest", async () => {
      getRouteManifest.mockReturnValue([]);

      const res = await api.get(`${BASE}/endpoints`).expect(200);

      expect(res.body).toEqual(okEnvelope({ items: [], total: 0 }));
    });
  });

  describe("GET /metrics/requests", () => {
    // Regression: a failure handled by the app-level error handler was
    // recorded after the router had restored req.baseUrl, so it showed up as
    // "POST /database/tables/:table/mutate" and never lined up with the
    // endpoint manifest.
    it("records a failed request under its full mounted route path", async () => {
      await api
        .post(`${BASE}/database/tables/transactions/mutate`)
        .send({ changes: "not-an-array" })
        .expect(400);

      const res = await api.get(`${BASE}/metrics/requests`).expect(200);
      const items = bodyAt(res, "data", "items") as Array<{
        method: string;
        path: string;
        errors: number;
      }>;

      expect(items).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: "/api/admin/database/tables/:table/mutate",
          errors: 1,
        }),
      );
      expect(items.map((item) => item.path)).not.toContain(
        "/database/tables/:table/mutate",
      );
    });
  });
});

function mockGitHubReleaseBody(body: string) {
  const httpsGet = https.get as unknown as Mock;
  httpsGet.mockImplementation((url, options, callback) => {
    expect(url).toContain("/releases/latest");
    expect(options).toMatchObject({
      headers: {
        "User-Agent": "Vision-backend",
      },
    });

    const response = {
      on: vi.fn(),
    };

    response.on.mockImplementation((event, handler) => {
      if (event === "data") {
        handler(body);
      }
      if (event === "end") {
        handler();
      }
      return response;
    });

    callback(response);

    const request = { on: vi.fn() };
    request.on.mockImplementation(() => request);
    return request;
  });
}
