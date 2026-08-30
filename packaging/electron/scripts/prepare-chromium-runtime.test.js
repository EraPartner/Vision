"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CHROMIUM_VERSION,
  assertSafeDestination,
  prepareChromiumRuntime,
} = require("./prepare-chromium-runtime");

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
    const metadata = prepareChromiumRuntime({ source, destination });
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
