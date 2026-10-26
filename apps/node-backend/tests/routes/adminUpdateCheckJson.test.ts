/**
 * GET /update/check when the release API answers with JSON that is not a
 * release object: the route reports "no published releases", as it does for
 * `null`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import https from "https";
import { mockLogger } from "../helpers/mockLogger.ts";
import { routeAgent, okEnvelope } from "../helpers/routeApp.ts";
import { mockConnection } from "../helpers/repoMocks.ts";
import { bodyAt } from "../helpers/responseBody.ts";

vi.mock("https", () => ({ default: { get: vi.fn() } }));
vi.mock("../../src/database/connection.ts", () => mockConnection());
vi.mock("../../src/config/logger.ts", () => ({ logger: mockLogger() }));
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

const { default: adminRouter } = await import("../../src/routes/admin.ts");
const api = routeAgent(adminRouter, { mountPath: "/api/admin" });

interface FakeResponse {
  on: (event: string, handler: (chunk?: string) => void) => FakeResponse;
}

function mockReleaseBody(body: string) {
  const httpsGet = https.get as unknown as Mock<
    (
      url: string,
      options: unknown,
      callback: (response: FakeResponse) => void,
    ) => unknown
  >;
  httpsGet.mockImplementation((_url, _options, callback) => {
    const response: FakeResponse = {
      on: (event, handler) => {
        if (event === "data") handler(body);
        if (event === "end") handler();
        return response;
      },
    };
    callback(response);
    const request = { on: () => request };
    return request;
  });
}

const noRelease = okEnvelope({
  up_to_date: true,
  current_version: "unknown",
  error: "No published releases found",
  latest_version: null,
  update_mode: "source",
});

describe("GET /update/check with unexpected release JSON", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APP_VERSION;
  });

  it.each(["[]", "7", '"text"', '{"tag_name":42}', '{"tag_name":""}'])(
    "reports no release for %s",
    async (body) => {
      mockReleaseBody(body);

      const res = await api.get("/api/admin/update/check").expect(200);

      expect(res.body).toEqual(noRelease);
    },
  );

  it("ignores mistyped optional fields of a valid release", async () => {
    mockReleaseBody(
      JSON.stringify({ tag_name: "v3.0.0", body: 5, html_url: [], extra: 1 }),
    );

    const res = await api.get("/api/admin/update/check").expect(200);

    expect(bodyAt(res, "data", "latest_version")).toBe("v3.0.0");
    expect(bodyAt(res, "data", "release_notes")).toBe("");
  });
});
