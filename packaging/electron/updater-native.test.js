"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { execFileSync, spawnSync } = require("node:child_process");

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
    assert.equal(script.match(/--filter="merge \$PROTECT_FILE"/g)?.length, 2);
    assert.doesNotMatch(script, /docker compose|open -a Docker/);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

async function prepareSourceUpdateFixture({ failInstall = false } = {}) {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-source-updater-behavior-"),
  );
  const source = path.join(temp, "source");
  const destination = path.join(temp, "Vision");
  const fakeBin = path.join(temp, "bin");
  await fs.promises.mkdir(source);
  await fs.promises.mkdir(destination);
  await fs.promises.mkdir(fakeBin);
  await fs.promises.writeFile(path.join(destination, ".gitignore"), "venv/\n");
  await fs.promises.writeFile(
    path.join(destination, "tracked.txt"),
    "old value\n",
  );
  await fs.promises.mkdir(path.join(destination, "venv"));
  await fs.promises.writeFile(
    path.join(destination, "venv/keep.txt"),
    "keep\n",
  );
  await fs.promises.mkdir(path.join(destination, "ordinary-stale"));
  await fs.promises.writeFile(
    path.join(destination, "ordinary-stale/remove.txt"),
    "remove\n",
  );
  execFileSync("git", ["init", "-q", destination]);
  execFileSync("git", ["-C", destination, "add", ".gitignore", "tracked.txt"]);
  await fs.promises.writeFile(path.join(source, ".gitignore"), "venv/\n");
  await fs.promises.writeFile(path.join(source, "tracked.txt"), "new\n");
  await fs.promises.writeFile(path.join(source, "new.txt"), "new\n");
  for (const command of ["bun", "open", "xattr"]) {
    const file = path.join(fakeBin, command);
    await fs.promises.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  if (failInstall) {
    const wrapper = path.join(fakeBin, "rsync");
    const failedMarker = path.join(temp, "install-failed");
    await fs.promises.writeFile(
      wrapper,
      `#!/bin/sh\n/usr/bin/rsync "$@"\nstatus=$?\ncase " $* " in\n  *" --delete "*)\n    if [ ! -f ${JSON.stringify(failedMarker)} ]; then\n      touch ${JSON.stringify(failedMarker)}\n      exit 1\n    fi\n    ;;\nesac\nexit "$status"\n`,
      { mode: 0o755 },
    );
  }
  const scriptPath = path.join(temp, "install.sh");
  writeInstallerScript({
    scriptPath,
    sourceRootPath: source,
    sourceLaunchPath: "",
    destRootPath: destination,
    hostPid: 999999,
  });
  return { temp, source, destination, fakeBin, scriptPath };
}

test("source install preserves pre-existing untracked content and deletes ordinary stale files", async () => {
  const fixture = await prepareSourceUpdateFixture();
  try {
    const result = spawnSync("/bin/bash", [fixture.scriptPath], {
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "venv/keep.txt"),
        "utf8",
      ),
      "keep\n",
    );
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "ordinary-stale")),
      false,
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "tracked.txt"),
        "utf8",
      ),
      "new\n",
    );
  } finally {
    await fs.promises.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("source rollback uses the same pre-update protection manifest", async () => {
  const fixture = await prepareSourceUpdateFixture({ failInstall: true });
  try {
    const result = spawnSync("/bin/bash", [fixture.scriptPath], {
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "venv/keep.txt"),
        "utf8",
      ),
      "keep\n",
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "tracked.txt"),
        "utf8",
      ),
      "old value\n",
    );
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "new.txt")),
      false,
    );
  } finally {
    await fs.promises.rm(fixture.temp, { recursive: true, force: true });
  }
});
