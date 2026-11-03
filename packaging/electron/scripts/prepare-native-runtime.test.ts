import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafeNativeDestination,
  bundleDatabaseTool,
  compileBackend,
  manifestEntries,
  signCompiledBackend,
} from "./prepare-native-runtime";

void test("native payload replacement is restricted to a native-runtime directory", () => {
  assert.equal(
    assertSafeNativeDestination("/private/tmp/vision-build/native-runtime"),
    path.resolve("/private/tmp/vision-build/native-runtime"),
  );
  assert.throws(
    () => assertSafeNativeDestination("/private/tmp/vision-build"),
    /must end in native-runtime/,
  );
  assert.throws(
    () => assertSafeNativeDestination("/"),
    /must end in native-runtime/,
  );
});

void test("native payload manifests reject symbolic links", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-manifest-links-"),
  );
  try {
    const target = path.join(root, "target.txt");
    await fs.promises.writeFile(target, "payload");
    await fs.promises.symlink(target, path.join(root, "link.txt"));
    assert.throws(() => manifestEntries(root), /unsupported entry/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test(
  "compiled backend is re-signed after Bun embeds the application",
  { skip: process.platform !== "darwin" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-sign-test-"));
    const binary = path.join(root, "vision-backend");
    try {
      fs.copyFileSync(process.execPath, binary);
      fs.chmodSync(binary, 0o755);
      assert.doesNotThrow(() => signCompiledBackend(binary));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const exitCode of [0, 1]) {
  void test(`backend compile removes Bun scratch files it created (exit ${exitCode})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-compile-test-"));
    try {
      const earlier = ".1111111111111111-00000000.bun-build";
      fs.writeFileSync(path.join(root, earlier), "");
      // Stands in for `bun build --compile`: leaves a scratch file in its
      // working directory, as Bun does when a compile does not finish.
      const fakeBun = path.join(root, "fake-bun");
      fs.writeFileSync(
        fakeBun,
        `#!/bin/sh\ntouch .2222222222222222-00000000.bun-build\nexit ${exitCode}\n`,
        { mode: 0o755 },
      );
      const compile = () =>
        compileBackend(fakeBun, "main.ts", path.join(root, "out"), root);
      if (exitCode === 0) compile();
      else assert.throws(compile, /compilation exited 1/);
      assert.deepEqual(
        fs.readdirSync(root).filter((name) => name.endsWith(".bun-build")),
        [earlier],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

void test("the database tool is bundled for Bun at the packaged path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-db-tool-test-"));
  try {
    // Stands in for `bun build`: records its arguments and writes --outfile.
    const fakeBun = path.join(root, "fake-bun");
    fs.writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$@" > args.txt\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--outfile" ]; then echo bundled > "$2"; fi\n  shift\ndone\n`,
      { mode: 0o755 },
    );
    const outfile = path.join(root, "tools", "db-file.js");
    fs.mkdirSync(path.dirname(outfile));
    bundleDatabaseTool(fakeBun, "apps/node-backend/scripts/db-file.ts", outfile, root);
    assert.equal(fs.readFileSync(outfile, "utf8"), "bundled\n");
    assert.deepEqual(
      fs.readFileSync(path.join(root, "args.txt"), "utf8").trim().split("\n"),
      ["build", "--target=bun", "apps/node-backend/scripts/db-file.ts", "--outfile", outfile],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("database tool bundling fails when Bun fails or writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-db-tool-test-"));
  try {
    const failing = path.join(root, "failing-bun");
    fs.writeFileSync(failing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const silent = path.join(root, "silent-bun");
    fs.writeFileSync(silent, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const outfile = path.join(root, "db-file.js");
    assert.throws(
      () => bundleDatabaseTool(failing, "db-file.ts", outfile, root),
      /bundling exited 3/,
    );
    assert.throws(
      () => bundleDatabaseTool(silent, "db-file.ts", outfile, root),
      /produced no output/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
