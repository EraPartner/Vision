"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  init,
  pickNativeAppZip,
  parseSha256Body,
  verifyUpdateChecksum,
  recordUpdateDecision,
  launchAuditedInstaller,
  updaterChildEnv,
  launchPreparedNativeInstaller,
  writeInstallerScript,
} = require("./updater");

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
  const events = [];
  init({ recordAuditUpdateDecision: async (event) => events.push(event) });
  await verifyUpdateChecksum(
    "a".repeat(64),
    "a".repeat(64),
    "v1.2.3",
    "native",
  );
  await assert.rejects(
    verifyUpdateChecksum("a".repeat(64), "b".repeat(64), "v1.2.3", "native"),
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
    recordUpdateDecision("install_requested", "v1.2.3", "native"),
    /audit bridge is unavailable/,
  );
  init({
    recordAuditUpdateDecision: async () => {
      throw new Error("audit down");
    },
  });
  await assert.rejects(
    recordUpdateDecision("install_requested", "v1.2.3", "native"),
    /audit down/,
  );
});

test("installer launch follows the recorded decision and failure is recorded", async () => {
  const calls = [];
  init({
    recordAuditUpdateDecision: async ({ decision }) => calls.push(decision),
  });
  await assert.rejects(
    launchAuditedInstaller("v1.2.3", "native", async () => {
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
    launchAuditedInstaller("v1.2.3", "native", async () =>
      calls.push("unexpected"),
    ),
    /audit down/,
  );
  assert.equal(calls.includes("unexpected"), false);
});
const {
  parseInstallerArgs,
  validateVisionAppPath,
  installNativeUpdate,
} = require("./native-update-installer");

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
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

async function prepareSourceUpdateFixture({
  failInstall = false,
  failBunInstall = false,
  failElectronBinaryInstall = false,
  bunVersion = "1.3.14",
} = {}) {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-source-updater-behavior-"),
  );
  const source = path.join(temp, "source");
  const destination = path.join(temp, "Vision");
  const fakeBin = path.join(temp, "bin");
  await fs.promises.mkdir(source);
  await fs.promises.mkdir(destination);
  await fs.promises.mkdir(fakeBin);
  await fs.promises.writeFile(
    path.join(destination, ".gitignore"),
    "venv/\nnode_modules/\n",
  );
  await fs.promises.writeFile(
    path.join(destination, "tracked.txt"),
    "old value\n",
  );
  await fs.promises.mkdir(path.join(destination, "node_modules"));
  await fs.promises.writeFile(
    path.join(destination, "node_modules/old.txt"),
    "old dependency\n",
  );
  await fs.promises.mkdir(
    path.join(destination, "apps/frontend/node_modules"),
    { recursive: true },
  );
  await fs.promises.mkdir(
    path.join(destination, "packaging/electron/node_modules"),
    { recursive: true },
  );
  await fs.promises.writeFile(
    path.join(destination, "packaging/electron/node_modules/old.txt"),
    "old Electron dependency\n",
  );
  await fs.promises.writeFile(
    path.join(destination, "apps/frontend/node_modules/old.txt"),
    "old frontend dependency\n",
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
  await fs.promises.writeFile(
    path.join(source, ".gitignore"),
    "venv/\nnode_modules/\n",
  );
  await fs.promises.writeFile(path.join(source, "tracked.txt"), "new\n");
  await fs.promises.writeFile(path.join(source, "new.txt"), "new\n");
  await fs.promises.mkdir(path.join(source, "packaging/electron"), {
    recursive: true,
  });
  await fs.promises.writeFile(
    path.join(source, "packaging/electron/package.json"),
    '{"name":"vision-electron"}\n',
  );
  for (const command of ["open", "xattr"]) {
    const file = path.join(fakeBin, command);
    await fs.promises.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  await fs.promises.writeFile(
    path.join(fakeBin, "bun"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${bunVersion}; exit 0; fi\nif [ "$1" = "install" ]; then\n  if [ "$(basename "$PWD")" = electron ]; then\n    mkdir -p node_modules/.bin node_modules/electron\n    echo new > node_modules/new.txt\n    : > node_modules/.bin/electron\n    chmod +x node_modules/.bin/electron\n    : > node_modules/electron/install.js\n    exit 0\n  fi\n  mkdir -p node_modules apps/frontend/node_modules\n  echo new > node_modules/new.txt\n  echo new > apps/frontend/node_modules/new.txt\n  ${failBunInstall ? "exit 1" : "exit 0"}\nfi\ncase "$1" in\n  */electron/install.js)\n    ${failElectronBinaryInstall ? "exit 1" : "mkdir -p node_modules/electron/dist/Electron.app/Contents/MacOS; : > node_modules/electron/dist/Electron.app/Contents/MacOS/Electron; chmod +x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron; exit 0"}\n    ;;\nesac\nexit 0\n`,
    { mode: 0o755 },
  );
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
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "node_modules/new.txt")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "node_modules/old.txt")),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.destination,
          "packaging/electron/node_modules/old.txt",
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.destination,
          "packaging/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.destination, "apps/frontend/node_modules/new.txt"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.destination, "apps/frontend/node_modules/old.txt"),
      ),
      false,
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
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "node_modules/old.txt")),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.destination, "apps/frontend/node_modules/old.txt"),
      ),
      true,
    );
  } finally {
    await fs.promises.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("source rollback restores files when locked dependency installation fails", async () => {
  const fixture = await prepareSourceUpdateFixture({ failBunInstall: true });
  try {
    const result = spawnSync("/bin/bash", [fixture.scriptPath], {
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
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
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "node_modules/old.txt")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "node_modules/new.txt")),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.destination, "apps/frontend/node_modules/old.txt"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.destination, "apps/frontend/node_modules/new.txt"),
      ),
      false,
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "venv/keep.txt"),
        "utf8",
      ),
      "keep\n",
    );
  } finally {
    await fs.promises.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("source rollback restores Electron dependencies when its binary install fails", async () => {
  const fixture = await prepareSourceUpdateFixture({
    failElectronBinaryInstall: true,
  });
  try {
    const result = spawnSync("/bin/bash", [fixture.scriptPath], {
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "tracked.txt"),
        "utf8",
      ),
      "old value\n",
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.destination,
          "packaging/electron/node_modules/old.txt",
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.destination,
          "packaging/electron/node_modules/new.txt",
        ),
      ),
      false,
    );
  } finally {
    await fs.promises.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("source updater rejects an unexpected Bun version before changing files", async () => {
  const fixture = await prepareSourceUpdateFixture({ bunVersion: "9.9.9" });
  try {
    const result = spawnSync("/bin/bash", [fixture.scriptPath], {
      env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /require installed Bun 1\.3\.14/);
    assert.equal(
      await fs.promises.readFile(
        path.join(fixture.destination, "tracked.txt"),
        "utf8",
      ),
      "old value\n",
    );
    assert.equal(
      fs.existsSync(path.join(fixture.destination, "node_modules/old.txt")),
      true,
    );
  } finally {
    await fs.promises.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("source updater finds Bun in the launcher's home directory fallback", async () => {
  const fixture = await prepareSourceUpdateFixture();
  try {
    const home = path.join(fixture.temp, "home");
    const bunDirectory = path.join(home, ".bun/bin");
    await fs.promises.mkdir(bunDirectory, { recursive: true });
    await fs.promises.rename(
      path.join(fixture.fakeBin, "bun"),
      path.join(bunDirectory, "bun"),
    );
    const result = spawnSync("/bin/bash", [fixture.scriptPath], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fixture.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
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
