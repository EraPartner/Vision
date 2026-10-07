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
vi.mock("../src/config/logger.ts", () => ({
  logger: { warn: vi.fn() },
}));

import {
  __ANALYSIS_ROLE,
  ensureAnalysisRole,
} from "../src/database/analysisRoleBootstrap.ts";

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

  it("grants approved views to a safe native executor without role administration", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ can_create: false }] })
      .mockResolvedValueOnce({
        rows: [
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolinherit: false,
            rolreplication: false,
            rolbypassrls: false,
            rolcanlogin: true,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const result = await ensureAnalysisRole({
      databaseUrl: "postgres://app:secret@localhost/vision",
      migrationsUrl: "postgres://owner:secret@localhost/vision",
      analysisUrl: `postgres://${__ANALYSIS_ROLE}:secret@localhost/vision`,
    });
    expect(result).toEqual({ status: "exists" });
    const statements = client.query.mock.calls.map(([sql]) => sql).join("\n");
    expect(statements).not.toMatch(/ALTER ROLE|CREATE ROLE/);
    expect(statements.match(/GRANT SELECT ON vision_analysis\./g)).toHaveLength(
      6,
    );
  });

  it("refuses to grant views to an elevated preprovisioned executor", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ can_create: false }] })
      .mockResolvedValueOnce({ rows: [{ rolsuper: true, rolcanlogin: true }] });
    await expect(
      ensureAnalysisRole({
        databaseUrl: "postgres://app:secret@localhost/vision",
        analysisUrl: `postgres://${__ANALYSIS_ROLE}:secret@localhost/vision`,
      }),
    ).resolves.toEqual({ status: "degraded", reason: "unsafe-executor-role" });
    expect(
      client.query.mock.calls.map(([sql]) => sql).join("\n"),
    ).not.toContain("GRANT");
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
