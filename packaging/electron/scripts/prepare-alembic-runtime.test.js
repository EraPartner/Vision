"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ALEMBIC_VERSION,
  ALEMBIC_RUNTIME_IMPORTS,
  PYINSTALLER_VERSION,
  assertSafeDestination,
  pyInstallerArgs,
  pyInstallerEnvironment,
} = require("./prepare-alembic-runtime");

test("Alembic packager pins its build tool and replacement target", () => {
  assert.equal(ALEMBIC_VERSION, "1.19.1");
  assert.equal(PYINSTALLER_VERSION, "6.22.2");
  assert.equal(
    assertSafeDestination("/private/tmp/vision-runtime/vision-alembic"),
    "/private/tmp/vision-runtime/vision-alembic",
  );
  assert.throws(() => assertSafeDestination("/"), /Unsafe/);
  assert.throws(
    () => assertSafeDestination("/private/tmp/vision-alembic.bin"),
    /Unsafe/,
  );
});

test("Alembic packager includes imports loaded by the external migration environment", () => {
  assert.deepEqual(ALEMBIC_RUNTIME_IMPORTS, [
    "logging.config",
    "dotenv",
    "psycopg2._psycopg",
  ]);
  const args = pyInstallerArgs({
    dist: "/private/tmp/dist",
    work: "/private/tmp/work",
    spec: "/private/tmp/spec",
    entrypoint: "/source/vision-alembic.py",
  });
  for (const moduleName of ALEMBIC_RUNTIME_IMPORTS) {
    const moduleIndex = args.indexOf(moduleName);
    assert.ok(moduleIndex > 0);
    assert.equal(args[moduleIndex - 1], "--hidden-import");
  }
  assert.equal(args.at(-1), "/source/vision-alembic.py");
});

test("Alembic packager isolates its cache and excludes unrelated secrets", () => {
  const env = pyInstallerEnvironment("/tmp/vision-pyinstaller", {
    PATH: "/usr/bin",
    VISION_BUILD_SECRET: "must-not-leak",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    PYINSTALLER_CONFIG_DIR: "/tmp/vision-pyinstaller",
  });
});

test("Alembic wrapper reports the canonical upstream program name", () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, "vision-alembic.py"),
    "utf8",
  );
  assert.match(wrapper, /prog="alembic"/);
  assert.match(wrapper, /--vision-runtime-self-test/);
  assert.match(wrapper, /from logging\.config import fileConfig/);
  assert.match(wrapper, /from dotenv import load_dotenv/);
  assert.doesNotMatch(wrapper, /prog="vision-alembic"/);
});
