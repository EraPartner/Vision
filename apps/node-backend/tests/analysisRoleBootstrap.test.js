import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
};

vi.mock("pg", () => ({
  default: {
    Client: class MockClient {
      constructor() {
        return client;
      }
    },
  },
}));
vi.mock("../src/config/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import {
  __ANALYSIS_ROLE,
  ensureAnalysisRole,
} from "../src/database/analysisRoleBootstrap.js";

describe("analysis role bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.connect.mockResolvedValue();
    client.end.mockResolvedValue();
  });

  it("creates a non-inheriting login and resets grants to approved views", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ can_create: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    await expect(
      ensureAnalysisRole({
        databaseUrl: "postgres://owner:secret@localhost/vision",
        migrationsUrl: "postgres://owner:secret@localhost/vision",
        analysisUrl: `postgres://${__ANALYSIS_ROLE}:secret@localhost/vision`,
      }),
    ).resolves.toEqual({ status: "created" });

    const statements = client.query.mock.calls.map(([sql]) => sql).join("\n");
    expect(statements).toContain("NOINHERIT");
    expect(statements).toContain("default_transaction_read_only = on");
    expect(statements).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public",
    );
    expect(statements).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA vision_analysis",
    );
    expect(statements.match(/GRANT SELECT ON vision_analysis\./g)).toHaveLength(
      6,
    );
  });

  it("fails closed when the configured login is not the fixed role", async () => {
    const log = { warn: vi.fn() };
    await expect(
      ensureAnalysisRole({
        databaseUrl: "postgres://owner:secret@localhost/vision",
        analysisUrl: "postgres://owner:secret@localhost/vision",
        log,
      }),
    ).resolves.toEqual({
      status: "degraded",
      reason: "invalid-analysis-url",
    });
    expect(client.connect).not.toHaveBeenCalled();
  });
});
