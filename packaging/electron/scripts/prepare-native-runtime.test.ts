import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafeNativeDestination,
  compileBackend,
  manifestEntries,
  signCompiledBackend,
} from "./prepare-native-runtime";

test("native payload replacement is restricted to a native-runtime directory", () => {
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

test("native payload manifests reject symbolic links", async () => {
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

test(
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
  test(`backend compile removes Bun scratch files it created (exit ${exitCode})`, () => {
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
