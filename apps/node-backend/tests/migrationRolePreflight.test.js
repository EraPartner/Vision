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
    mocks.appQuery.mockReset();
    mocks.migrationQuery.mockReset();
    mocks.connect.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    process.env.DATABASE_URL =
      "postgresql://vision_app:redacted@127.0.0.1:5432/vision";
    process.env.DATABASE_URL_MIGRATIONS =
      "postgresql://vision_owner:redacted@127.0.0.1:5432/vision";
  });

  it("routes automation and Demo schema writes through the guarded runner", () => {
    const read = (relativePath) =>
      readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    const ci = read(".github/workflows/ci.yml");
    const release = read(".github/workflows/release.yml");
    const testDb = read("scripts/with-test-db.sh");
    const nativeStack = read(".github/scripts/with-native-stack.sh");
    const demo = read("packaging/electron/runtime/native.js");

    expect(ci).toContain("scripts/with-test-db.sh --coverage");
    expect(ci).toContain(".github/scripts/with-native-stack.sh");
    expect(release).toContain(".github/scripts/with-native-stack.sh");
    for (const wrapper of [testDb, nativeStack, demo]) {
      expect(wrapper).toContain("apps/node-backend/scripts/db-migrate.js");
    }
    for (const contents of [ci, release, testDb, nativeStack, demo]) {
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
      .mockResolvedValueOnce({ rows: [{ version_num: "0001_initial" }] })
      .mockResolvedValueOnce({ rows: [{ len: 32 }] })
      .mockResolvedValueOnce({ rows: [] });

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
      .mockResolvedValueOnce({ rows: [] });

    await expect(stampBaselineIfLegacy()).resolves.toEqual({
      skipped: true,
      reason: "alembic_version table empty",
    });

    expect(mocks.appQuery).toHaveBeenCalledTimes(2);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.migrationQuery).not.toHaveBeenCalled();
  });

  it("refuses to stamp an old revision before a restore-tested bridge", async () => {
    mocks.migrationQuery
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [{ version_num: "0002_add_url" }] });

    await expect(stampBaselineIfLegacy()).rejects.toThrow(
      "requires an explicit, restore-tested bridge",
    );
    expect(mocks.migrationQuery).toHaveBeenCalledTimes(2);
    expect(mocks.migrationQuery).not.toHaveBeenCalledWith(
      expect.stringMatching(/^ALTER TABLE|^UPDATE alembic_version/),
      expect.anything(),
    );
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
