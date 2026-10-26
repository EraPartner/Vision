import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const wrapper = resolve(import.meta.dirname, "../with-test-db.sh");

void test("test:db ignores an inherited database URL unless explicitly opted in", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "vision-test-db-bin-"));
  try {
    for (const tool of [
      "postgres",
      "initdb",
      "pg_ctl",
      "pg_isready",
      "createdb",
      "psql",
    ]) {
      const file = join(fakeBin, tool);
      writeFileSync(
        file,
        tool === "postgres"
          ? '#!/bin/sh\necho "postgres (PostgreSQL) 18.0"\n'
          : "#!/bin/sh\nexit 99\n",
      );
      chmodSync(file, 0o755);
    }

    const env = {
      ...process.env,
      TEST_DATABASE_URL: "postgresql://unsafe.example.invalid/vision",
      DATABASE_URL: "postgresql://unsafe.example.invalid/vision",
      VISION_TEST_POSTGRES_BIN: fakeBin,
      VISION_TEST_DB_CHECK_ONLY: "1",
      VISION_TEST_DB_USE_CALLER: "0",
    };
    const safe = spawnSync("sh", [wrapper], { env, encoding: "utf8" });
    assert.equal(safe.status, 0, safe.stderr);
    assert.match(safe.stdout, /Ignoring inherited database URLs/);
    assert.match(safe.stdout, /Native PostgreSQL 18 tools are available/);

    const retiredCloud = spawnSync("sh", [wrapper], {
      env: {
        ...env,
        CODEX_SESSION_ENV: "cloud",
        TEST_DATABASE_URL:
          "postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test",
      },
      encoding: "utf8",
    });
    assert.equal(retiredCloud.status, 0, retiredCloud.stderr);
    assert.match(retiredCloud.stdout, /Ignoring inherited database URLs/);
    assert.match(
      retiredCloud.stdout,
      /Native PostgreSQL 18 tools are available/,
    );

    const explicit = spawnSync("sh", [wrapper], {
      env: { ...env, VISION_TEST_DB_USE_CALLER: "1" },
      encoding: "utf8",
    });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(
      explicit.stdout,
      /Caller-managed TEST_DATABASE_URL is available/,
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
