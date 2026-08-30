"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  pickNativeAppZip,
  updaterChildEnv,
  launchPreparedNativeInstaller,
  writeInstallerScript,
} = require("./updater");
const {
  parseInstallerArgs,
  validateVisionAppPath,
} = require("./native-update-installer");

test("native updater selects only the packaged macOS app ZIP", () => {
  const selected = pickNativeAppZip({
    assets: [
      { name: "vision-source-launcher-1.2.3-arm64.zip" },
      { name: "Vision-1.2.3-arm64.dmg" },
      { name: "Vision-1.2.3-arm64-mac.zip" },
    ],
  });
  assert.equal(selected.name, "Vision-1.2.3-arm64-mac.zip");
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
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push("unref");
  const launched = launchPreparedNativeInstaller({
    installerPath: "/tmp/native-update-installer.js",
    installerArgs: ["--source-app", "/tmp/Vision.app"],
    stopRuntime: async () => calls.push("stop"),
    startRuntime: async () => calls.push("start"),
    executable: "/Applications/Vision.app/Contents/MacOS/Vision",
    spawnProcess: (_executable, args, options) => {
      calls.push("spawn");
      assert.deepEqual(args, [
        "/tmp/native-update-installer.js",
        "--source-app",
        "/tmp/Vision.app",
      ]);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await launched;
  assert.deepEqual(calls, ["stop", "spawn", "unref"]);
});

test("native updater restarts the backend when helper launch fails", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {};
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

test("source updates preserve the generated native service payload", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-source-updater-"),
  );
  try {
    const scriptPath = path.join(temp, "install-source-update.sh");
    writeInstallerScript({
      scriptPath,
      sourceRootPath: path.join(temp, "source"),
      sourceLaunchPath: path.join(temp, "launch.command"),
      destRootPath: path.join(temp, "Vision"),
      hostPid: 100,
    });
    const script = await fs.promises.readFile(scriptPath, "utf8");
    assert.match(script, /--exclude "packaging\/electron\/native-runtime"/);
    assert.doesNotMatch(script, /docker compose|open -a Docker/);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
