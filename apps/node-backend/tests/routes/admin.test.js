/**
 * Admin route tests.
 * Mirrors: apps/backend/tests/test_admin.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). The production admin mount
 * (main.js:324 — `mountRouter(app, '/api/admin', adminRateLimiter,
 * adminCsrfGuard, adminAuthMiddleware, adminRouter)`) is reproduced via the
 * harness's `before` slot with the REAL `createAdminAuthMiddleware`, driven by
 * the same `settings.admin.authToken` value main.js uses — so a
 * configured token is now actually enforced in tests, previously impossible
 * under the mock-router harness. `adminRateLimiter` (app-level, module-scoped
 * counters) and `adminCsrfGuard` (redundant with the harness's own global CSRF
 * mount, see routeApp.js fidelity map) are intentionally not added again here.
 * `adminMutateLimiter`, declared INSIDE admin.js on individual mutate routes,
 * is exercised for free since the real router is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, okEnvelope, errEnvelope } from "../helpers/routeApp.js";
import { createAdminAuthMiddleware } from "../../src/middleware/adminAuth.js";

vi.mock("https", () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock("../../src/database/connection.js", () => ({
  checkConnection: vi.fn(),
  getTableCount: vi.fn(),
  getClient: vi.fn(),
  query: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  admin: { enableResetDb: false, authToken: undefined },
  isDevelopment: () => true,
}));

vi.mock("../../src/config/config.js", () => ({ default: settings }));

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

vi.mock("../../src/services/priceProviderService.js", () => ({
  sanitizePersistedKinesisHistory: vi.fn(),
}));

vi.mock("../../src/services/providerHealthService.js", () => ({
  listProviderHealth: vi.fn(),
  probeProvider: vi.fn(),
}));

vi.mock("../../src/services/routeManifest.js", () => ({
  getRouteManifest: vi.fn(),
}));

import {
  checkConnection,
  getTableCount,
} from "../../src/database/connection.js";
import { sanitizePersistedKinesisHistory } from "../../src/services/priceProviderService.js";
import { listProviderHealth } from "../../src/services/providerHealthService.js";
import { getRouteManifest } from "../../src/services/routeManifest.js";
import https from "https";

const { default: adminRouter } = await import("../../src/routes/admin.js");

// Mirrors main.js:31 exactly — a per-request getter so a test can flip
// settings.admin.authToken between calls and see the guard react.
const adminAuthMiddleware = createAdminAuthMiddleware(
  () => settings.admin.authToken,
);

const api = routeAgent(adminRouter, {
  mountPath: "/api/admin",
  before: [adminAuthMiddleware],
});
const BASE = "/api/admin";

describe("Admin Routes", () => {
  const initialAppVersion = process.env.APP_VERSION;
  const initialAppImageTag = process.env.APP_IMAGE_TAG;

  beforeEach(() => {
    vi.clearAllMocks();
    settings.admin.enableResetDb = false;
    settings.admin.authToken = undefined;
    delete process.env.APP_VERSION;
    delete process.env.APP_IMAGE_TAG;
  });

  afterEach(() => {
    if (initialAppVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = initialAppVersion;
    }

    if (initialAppImageTag === undefined) {
      delete process.env.APP_IMAGE_TAG;
    } else {
      process.env.APP_IMAGE_TAG = initialAppImageTag;
    }
  });

  // Newly on-path: the mock-router harness never ran any middleware, so the
  // auth guard was never actually exercised even though it protects every
  // admin request in production.
  describe("admin auth guard (main.js:324)", () => {
    it("passes through with no configured token (loopback-only trust model)", async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      await api.get(`${BASE}/`).expect(200);
    });

    it("rejects a request with no Authorization header once a token is configured", async () => {
      settings.admin.authToken = "secret-token";

      const res = await api.get(`${BASE}/`).expect(401);
      expect(res.body).toEqual(errEnvelope({ code: "UNAUTHORIZED" }));
      expect(checkConnection).not.toHaveBeenCalled();
    });

    it("rejects a request bearing the wrong token", async () => {
      settings.admin.authToken = "secret-token";

      const res = await api
        .get(`${BASE}/`)
        .set("Authorization", "Bearer wrong")
        .expect(401);
      expect(res.body).toEqual(errEnvelope({ code: "UNAUTHORIZED" }));
    });

    it("passes through with the correct bearer token", async () => {
      settings.admin.authToken = "secret-token";
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      await api
        .get(`${BASE}/`)
        .set("Authorization", "Bearer secret-token")
        .expect(200);
    });
  });

  describe("GET /", () => {
    it("should return status when connected", async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      const res = await api.get(`${BASE}/`).expect(200);

      const result = res.body.data;
      expect(result.is_initialised).toBe(true);
      expect(result.table_count).toBe(5);
      expect(result.timestamp).toBeDefined();
    });

    it("should report uninitialised with no tables", async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(0);

      const res = await api.get(`${BASE}/`).expect(200);

      expect(res.body.data.is_initialised).toBe(false);
    });

    it("should report uninitialised when disconnected", async () => {
      checkConnection.mockResolvedValue(false);

      const res = await api.get(`${BASE}/`).expect(200);

      expect(res.body.data.is_initialised).toBe(false);
      expect(res.body.data.table_count).toBe(0);
    });

    it("should propagate errors when connection fails", async () => {
      checkConnection.mockRejectedValue(new Error("Connection failed"));

      const res = await api.get(`${BASE}/`).expect(500);
      expect(res.body.error.message).toBe("Connection failed");
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
      expect(res.body.error.message).toBe("driver stack trace");
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
          message: "Database reset requires force=true parameter",
          details: {
            hint: "Set force=true query parameter to confirm reset (DESTRUCTIVE)",
          },
        }),
      );
    });

    it("should accept force=true", async () => {
      settings.admin.enableResetDb = true;

      const res = await api
        .post(`${BASE}/database/reset?force=true`)
        .expect(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true }));
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

      const payload = res.body.data;
      expect(payload.latest_version).toBe("v1.2.3");
      expect(payload.published_at).toBe("2026-04-01T12:00:00Z");
      expect(payload.release_notes).toBe("Release notes");
      expect(payload.html_url).toBe(
        "https://github.com/EraPartner/Vision/releases/tag/v1.2.3",
      );
      expect(payload).toHaveProperty("up_to_date");
      expect(payload).toHaveProperty("current_version");
    });

    it("should report docker-compose update mode (HTTP clients are never Electron)", async () => {
      // Inside the desktop shell the frontend short-circuits to the Electron
      // IPC updater, so anything hitting this route is a self-hosted
      // docker-compose deployment with no in-app installer. Omitting the field
      // made the frontend default to 'source' and render a dead Install button.
      mockGitHubReleaseBody(JSON.stringify({ tag_name: "v9.9.9" }));

      const res = await api.get(`${BASE}/update/check`).expect(200);

      expect(res.body.data.update_mode).toBe("docker-compose");
    });

    it("should include version metadata in update check response", async () => {
      mockGitHubReleaseBody(JSON.stringify({ tag_name: "v2.1.0" }));

      const res = await api.get(`${BASE}/update/check`).expect(200);

      const payload = res.body.data;
      expect(payload.latest_version).toBe("v2.1.0");
      expect(payload).toHaveProperty("current_version");
      expect(payload).toHaveProperty("up_to_date");
    });

    it("should return no-release payload when GitHub returns not found", async () => {
      mockGitHubReleaseBody(JSON.stringify({ message: "Not Found" }));

      const res = await api.get(`${BASE}/update/check`).expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          up_to_date: true,
          error: "No published releases found",
          latest_version: null,
        }),
      );
    });

    it("should propagate error when release payload is invalid json", async () => {
      mockGitHubReleaseBody("{ invalid-json");

      const res = await api.get(`${BASE}/update/check`).expect(500);
      expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
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
      expect(res.body.error.message).toBe("boom");
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
      listProviderHealth.mockResolvedValue(providers);

      const res = await api.get(`${BASE}/providers/health`).expect(200);

      expect(res.body).toEqual(okEnvelope({ items: providers, total: 2 }));
    });

    it("GET /endpoints returns { items, total }", async () => {
      const manifest = [{ method: "GET", path: "/api/health" }];
      getRouteManifest.mockReturnValue(manifest);

      const res = await api.get(`${BASE}/endpoints`).expect(200);

      expect(res.body).toEqual(okEnvelope({ items: manifest, total: 1 }));
    });

    it("GET /endpoint-liveness returns { items, total } with live flags", async () => {
      getRouteManifest.mockReturnValue([
        { method: "GET", path: "/api/health" },
      ]);

      const res = await api.get(`${BASE}/endpoint-liveness`).expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          items: [{ method: "GET", path: "/api/health", live: true }],
          total: 1,
        }),
      );
    });

    it("GET /endpoints reports total 0 for an empty manifest", async () => {
      getRouteManifest.mockReturnValue([]);

      const res = await api.get(`${BASE}/endpoints`).expect(200);

      expect(res.body).toEqual(okEnvelope({ items: [], total: 0 }));
    });
  });
});

function mockGitHubReleaseBody(body) {
  const httpsGet = /** @type {import('vitest').Mock} */ (https.get);
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
