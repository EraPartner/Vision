import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHROMIUM_VERSION,
  assertSafeDestination,
  prepareChromiumRuntime,
} from "./prepare-chromium-runtime";

test("Chromium replacement is restricted to a chromium directory", () => {
  assert.equal(
    assertSafeDestination("/private/tmp/vision-runtime/chromium"),
    "/private/tmp/vision-runtime/chromium",
  );
  assert.throws(() => assertSafeDestination("/"), /Unsafe/);
  assert.throws(
    () => assertSafeDestination("/private/tmp/vision-runtime"),
    /Unsafe/,
  );
});

test("Chromium preparation pins the executable and carries its license", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-chromium-fixture-"),
  );
  const source = path.join(temp, "source");
  const destination = path.join(temp, "payload", "chromium");
  try {
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.writeFile(
      path.join(source, "chrome-headless-shell"),
      `#!/bin/sh\necho "Google Chrome for Testing ${CHROMIUM_VERSION}"\n`,
      { mode: 0o755 },
    );
    await fs.promises.writeFile(
      path.join(source, "LICENSE.headless_shell"),
      "synthetic license fixture\n",
    );
    const metadata = prepareChromiumRuntime({
      source,
      destination,
      platform: "darwin",
    });
    assert.equal(metadata.browserVersion, CHROMIUM_VERSION);
    assert.equal(
      await fs.promises.readFile(
        path.join(destination, metadata.licenseRelative),
        "utf8",
      ),
      "synthetic license fixture\n",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
