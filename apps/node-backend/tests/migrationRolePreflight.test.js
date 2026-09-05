import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockConnection } from "./helpers/repoMocks.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const mocks = vi.hoisted(() => ({
  appQuery: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  migrationQuery: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Client: class MockClient {
      connect = mocks.connect;
      end = mocks.end;
      query = mocks.migrationQuery;
    },
  },
}));

vi.mock("../src/database/connection.js", () =>
  mockConnection({ query: mocks.appQuery }),
);

vi.mock("../src/config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousMigrationsUrl = process.env.DATABASE_URL_MIGRATIONS;

const { runDatabaseAnalyze, __stampBaselineIfLegacy: stampBaselineIfLegacy } =
  await import("../src/database/migrate.js");

describe("migration role preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    process.env.DATABASE_URL =
      "postgresql://vision_app:redacted@127.0.0.1:5432/vision";
    process.env.DATABASE_URL_MIGRATIONS =
      "postgresql://vision_owner:redacted@127.0.0.1:5432/vision";
  });

  it("routes automation and Demo schema writes through the guarded runner", () => {
    const entrypoints = [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "packaging/electron/runtime/native.js",
    ];
    for (const relativePath of entrypoints) {
      const contents = readFileSync(
        path.join(repositoryRoot, relativePath),
        "utf8",
      );
      expect(contents).toContain("apps/node-backend/scripts/db-migrate.js");
      expect(contents).not.toMatch(
        /^\s*(?:\/venv\/bin\/alembic|"?\$ALEMBIC"?)\s+(?:upgrade|downgrade|stamp)\b/m,
      );
    }
  });

  afterAll(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousMigrationsUrl === undefined)
      delete process.env.DATABASE_URL_MIGRATIONS;
    else process.env.DATABASE_URL_MIGRATIONS = previousMigrationsUrl;
  });

  it("uses the migration role for alembic_version schema writes", async () => {
    mocks.migrationQuery
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [{ len: 32 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version_num: "0001_initial" }] });

    await expect(stampBaselineIfLegacy()).resolves.toEqual({
      skipped: true,
      reason: "already at baseline",
    });

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.migrationQuery).toHaveBeenCalledWith(
      "ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)",
      undefined,
    );
    expect(mocks.appQuery).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("preserves the application pool path for classic single-role installs", async () => {
    delete process.env.DATABASE_URL_MIGRATIONS;
    mocks.appQuery
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [{ len: 64 }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(stampBaselineIfLegacy()).resolves.toEqual({
      skipped: true,
      reason: "alembic_version table empty",
    });

    expect(mocks.appQuery).toHaveBeenCalledTimes(3);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.migrationQuery).not.toHaveBeenCalled();
  });

  it("runs database-wide ANALYZE through the migration role", async () => {
    mocks.migrationQuery.mockResolvedValueOnce({ rows: [] });

    await expect(runDatabaseAnalyze()).resolves.toBeUndefined();

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.migrationQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /FROM pg_catalog\.pg_tables[\s\S]*WHERE schemaname = 'public'[\s\S]*ANALYZE %I\.%I/,
      ),
      undefined,
    );
    expect(mocks.appQuery).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("keeps database-wide ANALYZE compatible with classic single-role installs", async () => {
    delete process.env.DATABASE_URL_MIGRATIONS;
    mocks.appQuery.mockResolvedValueOnce({ rows: [] });

    await expect(runDatabaseAnalyze()).resolves.toBeUndefined();

    expect(mocks.appQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /FROM pg_catalog\.pg_tables[\s\S]*WHERE schemaname = 'public'[\s\S]*ANALYZE %I\.%I/,
      ),
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.migrationQuery).not.toHaveBeenCalled();
  });
});
