const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync, chmodSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const wrapper = resolve(__dirname, "../with-test-db.sh");

test("test:db ignores an inherited database URL unless explicitly opted in", () => {
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
