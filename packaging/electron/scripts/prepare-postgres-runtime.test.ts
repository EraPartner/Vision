import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  POSTGRES_VERSION,
  REQUIRED_TOOLS,
  assertSafeDestination,
  commonDirectory,
  inspectDistribution,
  materializeSymlinks,
  removeUnshippedFiles,
} from "./prepare-postgres-runtime";

void test("packaged PostgreSQL paths retain their build-time relative layout", () => {
  assert.equal(
    commonDirectory([
      "/opt/homebrew/Cellar/postgresql@18/18.6/bin",
      "/opt/homebrew/lib/postgresql@18",
      "/opt/homebrew/share/postgresql@18",
    ]),
    "/opt/homebrew",
  );
});

void test("packaged PostgreSQL replacement is restricted to a postgres directory", () => {
  assert.equal(
    assertSafeDestination("/private/tmp/vision-runtime/postgres"),
    "/private/tmp/vision-runtime/postgres",
  );
  assert.throws(() => assertSafeDestination("/"), /Unsafe/);
  assert.throws(
    () => assertSafeDestination("/private/tmp/vision-runtime"),
    /Unsafe/,
  );
});

void test("PostgreSQL build symlinks are materialized inside the runtime", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-postgres-links-"),
  );
  const source = path.join(temp, "source.txt");
  const runtime = path.join(temp, "runtime");
  const link = path.join(runtime, "payload.txt");
  try {
    await fs.promises.mkdir(runtime);
    await fs.promises.writeFile(source, "postgres payload");
    await fs.promises.symlink(source, link);
    materializeSymlinks(runtime);
    assert.equal((await fs.promises.lstat(link)).isSymbolicLink(), false);
    assert.equal(await fs.promises.readFile(link, "utf8"), "postgres payload");
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("distribution inspection requires the pinned PostgreSQL minor and tools", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-postgres-inspect-"),
  );
  const bin = path.join(temp, "bin");
  const lib = path.join(temp, "lib");
  const share = path.join(temp, "share");
  try {
    await Promise.all(
      [bin, lib, share].map((directory) =>
        fs.promises.mkdir(directory, { recursive: true }),
      ),
    );
    const pgConfig = path.join(bin, "pg_config");
    await fs.promises.writeFile(
      pgConfig,
      `#!/bin/sh
case "$1" in
  --version) echo "PostgreSQL ${POSTGRES_VERSION} (test)" ;;
  --bindir) echo "${bin}" ;;
  --libdir|--pkglibdir) echo "${lib}" ;;
  --sharedir) echo "${share}" ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    for (const tool of REQUIRED_TOOLS)
      await fs.promises.writeFile(path.join(bin, tool), "test", {
        mode: 0o755,
      });

    const result = inspectDistribution(bin);
    assert.equal(result.version, POSTGRES_VERSION);
    assert.equal(result.prefix, temp);

    await fs.promises.writeFile(
      pgConfig,
      (await fs.promises.readFile(pgConfig, "utf8")).replace(
        POSTGRES_VERSION,
        "18.5",
      ),
      { mode: 0o755 },
    );
    assert.throws(() => inspectDistribution(bin), /must be 18\.6/);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

void test("static archives and PL/Python are left out of the packaged runtime", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-postgres-plpython-"),
  );
  const pkglib = path.join(temp, "lib", "postgresql");
  const extension = path.join(temp, "share", "postgresql", "extension");
  try {
    await fs.promises.mkdir(pkglib, { recursive: true });
    await fs.promises.mkdir(extension, { recursive: true });
    for (const name of ["plpython3.dylib", "libpgport.a", "pg_trgm.dylib"])
      await fs.promises.writeFile(path.join(pkglib, name), "");
    for (const name of ["jsonb_plpython3u.control", "pg_trgm.control"])
      await fs.promises.writeFile(path.join(extension, name), "");
    removeUnshippedFiles(temp);
    assert.deepEqual(await fs.promises.readdir(pkglib), ["pg_trgm.dylib"]);
    assert.deepEqual(await fs.promises.readdir(extension), ["pg_trgm.control"]);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
