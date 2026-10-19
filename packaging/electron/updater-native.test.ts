import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

import {
  init,
  pickNativeAppZip,
  parseSha256Body,
  verifyUpdateChecksum,
  recordUpdateDecision,
  launchAuditedInstaller,
  updaterChildEnv,
  launchPreparedNativeInstaller,
} from "./updater";
import type { UpdateDecisionEvent } from "./updater";
import {
  parseInstallerArgs,
  validateVisionAppPath,
  installNativeUpdate,
} from "./native-update-installer";

test("update checksum must contain exactly one hash for the selected ZIP", () => {
  const name = "Vision-1.2.3-arm64-mac.zip";
  const valid = `${"A".repeat(64)}  ${name}\n`;
  assert.equal(parseSha256Body(valid, name), "a".repeat(64));
  for (const body of [
    `${"a".repeat(64)}  other.zip\n`,
    `${"a".repeat(64)}  ${name}\n${"b".repeat(64)}  ${name}\n`,
    `prefix ${"a".repeat(64)}  ${name}\n`,
    `${"a".repeat(64)}  ${name} extra\n`,
    `${"a".repeat(64)} *${name}\n`,
    `${"a".repeat(63)}  ${name}\n`,
  ]) {
    assert.equal(parseSha256Body(body, name), null);
  }
});

test("update checksum decisions are recorded without file paths or URLs", async () => {
  const events: UpdateDecisionEvent[] = [];
  init({ recordAuditUpdateDecision: async (event) => events.push(event) });
  await verifyUpdateChecksum("a".repeat(64), "a".repeat(64), "v1.2.3");
  await assert.rejects(
    verifyUpdateChecksum("a".repeat(64), "b".repeat(64), "v1.2.3"),
    /Checksum mismatch/,
  );
  assert.deepEqual(events, [
    { decision: "checksum_verified", mode: "native", version: "v1.2.3" },
    { decision: "checksum_failed", mode: "native", version: "v1.2.3" },
  ]);
});

test("native update decisions fail closed when audit callback is missing or fails", async () => {
  init({});
  await assert.rejects(
    recordUpdateDecision("install_requested", "v1.2.3"),
    /audit bridge is unavailable/,
  );
  init({
    recordAuditUpdateDecision: async () => {
      throw new Error("audit down");
    },
  });
  await assert.rejects(
    recordUpdateDecision("install_requested", "v1.2.3"),
    /audit down/,
  );
});

test("installer launch follows the recorded decision and failure is recorded", async () => {
  const calls: string[] = [];
  init({
    recordAuditUpdateDecision: async ({ decision }) => calls.push(decision),
  });
  await assert.rejects(
    launchAuditedInstaller("v1.2.3", async () => {
      calls.push("launch");
      throw new Error("launch failed");
    }),
    /launch failed/,
  );
  assert.deepEqual(calls, ["install_requested", "launch", "install_failed"]);

  init({
    recordAuditUpdateDecision: async () => {
      throw new Error("audit down");
    },
  });
  await assert.rejects(
    launchAuditedInstaller("v1.2.3", async () => calls.push("unexpected")),
    /audit down/,
  );
  assert.equal(calls.includes("unexpected"), false);
});

test("native installer activates a synthetic app and restores the old app on launch failure", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-update-"),
  );
  const sourceApp = path.join(temp, "source", "Vision.app");
  const destinationApp = path.join(temp, "installed", "Vision.app");
  try {
    await fs.promises.mkdir(sourceApp, { recursive: true });
    await fs.promises.mkdir(destinationApp, { recursive: true });
    await fs.promises.writeFile(path.join(sourceApp, "version"), "new");
    await fs.promises.writeFile(path.join(destinationApp, "version"), "old");
    let openings = 0;
    assert.throws(
      () =>
        installNativeUpdate({
          sourceApp,
          destinationApp,
          hostPid: 99999999,
          spawnProcess: (command) => {
            if (command === "/usr/bin/open" && openings++ === 0)
              return { status: 1 };
            return { status: 0 };
          },
        }),
      /Updated Vision application did not open/,
    );
    assert.equal(
      await fs.promises.readFile(path.join(destinationApp, "version"), "utf8"),
      "old",
    );
    assert.equal(openings, 2);

    const result = installNativeUpdate({
      sourceApp,
      destinationApp,
      hostPid: 99999999,
      spawnProcess: () => ({ status: 0 }),
    });
    assert.equal(result.status, "installed");
    assert.equal(
      await fs.promises.readFile(path.join(destinationApp, "version"), "utf8"),
      "new",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("compiled native installer is self-contained and runs on its own", async () => {
  // prepareNativeUpdateInstaller copies this compiled file into a temporary
  // directory and runs it with ELECTRON_RUN_AS_NODE, away from the app.
  const compiled = path.join(__dirname, "native-update-installer.js");
  const source = await fs.promises.readFile(compiled, "utf8");
  const specifiers = [...source.matchAll(/\brequire\(([^)]*)\)/g)].map(
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0, "expected the compiled Node imports");
  for (const specifier of specifiers) {
    assert.match(String(specifier), /^"node:[a-z_/]+"$/);
  }

  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-installer-copy-"),
  );
  try {
    const copied = path.join(temp, "native-update-installer.js");
    await fs.promises.copyFile(compiled, copied);
    const result = spawnSync(process.execPath, [copied], {
      cwd: temp,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "Native update installer arguments are incomplete\n",
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("native updater selects only the packaged macOS app ZIP", () => {
  const selected = pickNativeAppZip({
    assets: [
      { name: "vision-source-launcher-1.2.3-arm64.zip" },
      { name: "Vision-1.2.3-arm64.dmg" },
      { name: "Vision-1.2.3-arm64-mac.zip" },
    ],
  });
  assert.equal(selected?.name, "Vision-1.2.3-arm64-mac.zip");
});

test("native installer accepts only argument-array Vision application paths", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-updater-"),
  );
  try {
    assert.throws(
      () => validateVisionAppPath(path.join(temp, "Other.app"), "source"),
      /specific Vision\.app/,
    );
    assert.deepEqual(
      parseInstallerArgs([
        "--source-app",
        path.join(temp, "Vision.app"),
        "--destination-app",
        "/Applications/Vision.app",
        "--host-pid",
        "100",
      ]),
      {
        sourceApp: path.join(temp, "Vision.app"),
        destinationApp: "/Applications/Vision.app",
        hostPid: 100,
      },
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("native updater stops the backend before spawning the fixed installer", async () => {
  const calls: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    unref: () => {
      calls.push("unref");
    },
  });
  const launched = launchPreparedNativeInstaller({
    installerPath: "/tmp/native-update-installer.js",
    installerArgs: ["--source-app", "/tmp/Vision.app"],
    stopRuntime: async () => calls.push("stop"),
    startRuntime: async () => calls.push("start"),
    executable: "/Applications/Vision.app/Contents/MacOS/Vision",
    spawnProcess: (_executable, args, options: SpawnOptions) => {
      calls.push("spawn");
      assert.deepEqual(args, [
        "/tmp/native-update-installer.js",
        "--source-app",
        "/tmp/Vision.app",
      ]);
      assert.equal(options.env?.ELECTRON_RUN_AS_NODE, "1");
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await launched;
  assert.deepEqual(calls, ["stop", "spawn", "unref"]);
});

test("native updater restarts the backend when helper launch fails", async () => {
  const calls: string[] = [];
  const child = Object.assign(new EventEmitter(), { unref: () => {} });
  await assert.rejects(
    launchPreparedNativeInstaller({
      installerPath: "/tmp/native-update-installer.js",
      installerArgs: [],
      stopRuntime: async () => calls.push("stop"),
      startRuntime: async () => calls.push("start"),
      spawnProcess: () => {
        calls.push("spawn");
        queueMicrotask(() => child.emit("error", new Error("spawn failed")));
        return child;
      },
    }),
    /spawn failed/,
  );
  assert.deepEqual(calls, ["stop", "spawn", "start"]);
});

test("native updater child environment excludes unrelated secrets", () => {
  const previous = process.env.VISION_UPDATE_TEST_SECRET;
  process.env.VISION_UPDATE_TEST_SECRET = "must-not-leak";
  try {
    const env = updaterChildEnv({ ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(env.VISION_UPDATE_TEST_SECRET, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  } finally {
    if (previous === undefined) delete process.env.VISION_UPDATE_TEST_SECRET;
    else process.env.VISION_UPDATE_TEST_SECRET = previous;
  }
});
