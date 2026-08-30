import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const harnessPath = path.join(repoRoot, "scripts", "with-test-db.sh");
const harnessSource = readFileSync(harnessPath, "utf8");
const migrationRunnerSource = readFileSync(
  path.join(repoRoot, "apps", "node-backend", "scripts", "db-migrate.js"),
  "utf8",
);

function runHarness(envOverrides) {
  const env = { ...process.env, ...envOverrides };
  delete env.TEST_DATABASE_URL;
  delete env.DATABASE_URL;
  return spawnSync("sh", [harnessPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function createFakePostgresBin() {
  const root = mkdtempSync(path.join(tmpdir(), "vision-test-db-harness-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  for (const tool of [
    "postgres",
    "initdb",
    "pg_ctl",
    "pg_isready",
    "createdb",
  ]) {
    const toolPath = path.join(bin, tool);
    writeFileSync(toolPath, "#!/bin/sh\necho 'postgres (PostgreSQL) 18.6'\n");
    chmodSync(toolPath, 0o755);
  }
  return { bin, root };
}

describe("disposable database test harness", () => {
  it("rejects unknown providers before starting a database", () => {
    const result = runHarness({ VISION_TEST_DB_PROVIDER: "remote" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VISION_TEST_DB_PROVIDER must be auto, native, or docker",
    );
  });

  it("rejects unsafe port values before starting a database", () => {
    const result = runHarness({
      VISION_TEST_DB_PROVIDER: "native",
      VISION_TEST_DB_PORT: "5432;echo unsafe",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VISION_TEST_DB_PORT must be a number from 1024 through 65535",
    );
    expect(result.stdout).not.toContain("unsafe");
  });

  it("keeps native PostgreSQL isolated and Docker optional", () => {
    expect(harnessSource).toContain("umask 077");
    expect(harnessSource).toContain("listen_addresses = '127.0.0.1'");
    expect(harnessSource).toContain("unix_socket_directories = ''");
    expect(harnessSource).toContain("--template=template0");
    expect(harnessSource).toContain("VISION_TEST_POSTGRES_BIN");
    expect(harnessSource).toContain("VISION_TEST_DB_PROVIDER");
    expect(harnessSource).toContain("postgres:18-alpine");
    expect(harnessSource).toContain(
      "bun run apps/node-backend/scripts/db-migrate.js",
    );
  });

  it("can probe native availability without initializing a cluster", () => {
    const fakePostgres = createFakePostgresBin();
    const result = runHarness({
      VISION_TEST_DB_PROVIDER: "native",
      VISION_TEST_DB_CHECK_ONLY: "1",
      VISION_TEST_POSTGRES_BIN: fakePostgres.bin,
    });
    rmSync(fakePostgres.root, { force: true, recursive: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Native PostgreSQL 18 tools are available");
    expect(result.stdout).not.toContain("Initializing disposable");
  });

  it("never removes Docker volumes or uses destructive Compose shutdown", () => {
    expect(harnessSource).not.toMatch(/docker\s+volume\s+rm/);
    expect(harnessSource).not.toMatch(/docker\s+compose[^\n]*down[^\n]*-v/);
    expect(harnessSource).not.toContain("/var/lib/postgresql/data:/");
  });

  it("probes migration executables and ignores stale virtual environments", () => {
    expect(migrationRunnerSource).toContain(
      'spawnSync(candidate, ["--version"]',
    );
    expect(migrationRunnerSource).toContain('".venv-native-build"');
    expect(migrationRunnerSource).toContain('"vision-alembic"');
    expect(migrationRunnerSource).toContain(
      "!result.error && result.status === 0",
    );
  });
});
