import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  cleanupLegacyAuditArtifacts,
  type LegacyCleanupExecFile,
} from "./legacy-audit-cleanup";

const MARKER = ".legacy-audit-cleanup-done";

interface SecurityCall {
  file: string;
  args: readonly string[];
  shell: false;
}

function stubExecFile(
  outcome: "ok" | "not-found" | "failure",
  calls: SecurityCall[],
): LegacyCleanupExecFile {
  return (file, args, options, callback) => {
    calls.push({ file, args, shell: options.shell });
    queueMicrotask(() => {
      if (outcome === "ok") return callback(null, "", "");
      const error = Object.assign(new Error("security failed"), {
        code: outcome === "not-found" ? 44 : 51,
      });
      callback(error, "", "");
    });
  };
}

function captureLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    log: {
      info: (message: string) => info.push(message),
      warn: (message: string) => warn.push(message),
    },
  };
}

async function tempUserData(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vision-legacy-audit-cleanup-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "userData");
  await fs.mkdir(userData);
  return userData;
}

async function seedReceiptFolder(userData: string): Promise<string> {
  const folder = path.join(userData, "audit-anchor");
  await fs.mkdir(folder);
  for (const name of [
    "key.enc",
    "checkpoint.json",
    "key.before-transfer.enc",
    "checkpoint.before-transfer.json",
    "checkpoint.json.tmp-123-0b8f",
  ]) {
    await fs.writeFile(path.join(folder, name), "x");
  }
  return folder;
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
}

const retired = async () => true;

test("leaves everything in place until the database has retired audit history", async (t) => {
  const userData = await tempUserData(t);
  const folder = await seedReceiptFolder(userData);
  const calls: SecurityCall[] = [];
  const { log, warn } = captureLog();
  const options = {
    userDataDir: userData,
    runtimeName: "vision",
    execFile: stubExecFile("ok", calls),
    log,
    platform: "darwin" as const,
  };

  assert.equal(
    await cleanupLegacyAuditArtifacts({
      ...options,
      retirementApplied: async () => false,
    }),
    "deferred",
  );
  assert.equal(
    await cleanupLegacyAuditArtifacts({
      ...options,
      retirementApplied: async () => {
        throw new Error("Native backend readiness timed out");
      },
    }),
    "incomplete",
  );
  assert.equal(await exists(folder), true);
  assert.deepEqual(calls, []);
  assert.equal(await exists(path.join(userData, MARKER)), false);
  assert.equal(warn.length, 1);

  assert.equal(
    await cleanupLegacyAuditArtifacts({ ...options, retirementApplied: retired }),
    "completed",
  );
  assert.equal(await exists(folder), false);
  assert.equal(calls.length, 1);
});

test("removes the receipt folder and deletes the Keychain item with exact arguments", async (t) => {
  const userData = await tempUserData(t);
  const folder = await seedReceiptFolder(userData);
  await fs.writeFile(path.join(userData, "settings.json"), "{}");
  const calls: SecurityCall[] = [];
  const { log, info, warn } = captureLog();

  const result = await cleanupLegacyAuditArtifacts({
    userDataDir: userData,
    runtimeName: "vision",
    execFile: stubExecFile("ok", calls),
    log,
    retirementApplied: retired,
    platform: "darwin",
  });

  assert.equal(result, "completed");
  assert.equal(await exists(folder), false);
  assert.equal(await exists(path.join(userData, "settings.json")), true);
  assert.deepEqual(calls, [
    {
      file: "/usr/bin/security",
      args: [
        "delete-generic-password",
        "-s",
        "com.vaultvoyager.vision.audit-witness",
        "-a",
        "latest-checkpoint",
      ],
      shell: false,
    },
  ]);
  assert.equal(info.length, 2);
  assert.deepEqual(warn, []);
  assert.equal(await exists(path.join(userData, MARKER)), true);
});

test("uses the demo Keychain service for the demo runtime", async (t) => {
  const userData = await tempUserData(t);
  const calls: SecurityCall[] = [];
  const { log } = captureLog();

  await cleanupLegacyAuditArtifacts({
    userDataDir: userData,
    runtimeName: "vision_demo",
    execFile: stubExecFile("ok", calls),
    log,
    retirementApplied: retired,
    platform: "darwin",
  });

  assert.equal(calls[0]?.args[2], "com.vaultvoyager.vision-demo.audit-witness");
});

test("treats a missing Keychain item (exit 44) as success and writes the marker", async (t) => {
  const userData = await tempUserData(t);
  const calls: SecurityCall[] = [];
  const { log, info, warn } = captureLog();

  const result = await cleanupLegacyAuditArtifacts({
    userDataDir: userData,
    runtimeName: "vision",
    execFile: stubExecFile("not-found", calls),
    log,
    retirementApplied: retired,
    platform: "darwin",
  });

  assert.equal(result, "completed");
  assert.equal(calls.length, 1);
  assert.deepEqual(info, []);
  assert.deepEqual(warn, []);
  assert.equal(await exists(path.join(userData, MARKER)), true);
});

test("logs a warning and still writes the marker when security fails otherwise", async (t) => {
  const userData = await tempUserData(t);
  const folder = await seedReceiptFolder(userData);
  const calls: SecurityCall[] = [];
  const { log, warn } = captureLog();

  const result = await cleanupLegacyAuditArtifacts({
    userDataDir: userData,
    runtimeName: "vision",
    execFile: stubExecFile("failure", calls),
    log,
    retirementApplied: retired,
    platform: "darwin",
  });

  assert.equal(result, "incomplete");
  assert.equal(await exists(folder), false);
  assert.equal(warn.length, 1);
  assert.match(warn[0] ?? "", /Keychain/);
  assert.equal(await exists(path.join(userData, MARKER)), true);
});

test("never throws when execFile itself throws", async (t) => {
  const userData = await tempUserData(t);
  const { log, warn } = captureLog();

  const result = await cleanupLegacyAuditArtifacts({
    userDataDir: userData,
    runtimeName: "vision",
    execFile: () => {
      throw new Error("spawn EACCES");
    },
    log,
    retirementApplied: retired,
    platform: "darwin",
  });

  assert.equal(result, "incomplete");
  assert.equal(warn.length, 1);
  assert.equal(await exists(path.join(userData, MARKER)), true);
});

test("removes only the link when the receipt folder is a symlink", async (t) => {
  const userData = await tempUserData(t);
  const outside = path.join(path.dirname(userData), "elsewhere");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  const link = path.join(userData, "audit-anchor");
  await fs.symlink(outside, link, "dir");
  const { log, info } = captureLog();

  const result = await cleanupLegacyAuditArtifacts({
    userDataDir: userData,
    runtimeName: "vision",
    execFile: stubExecFile("not-found", []),
    log,
    retirementApplied: retired,
    platform: "darwin",
  });

  assert.equal(result, "completed");
  assert.equal(await exists(link), false);
  assert.equal(
    await fs.readFile(path.join(outside, "keep.txt"), "utf8"),
    "keep",
  );
  assert.equal(info.length, 1);
});

test("a second run is skipped by the marker", async (t) => {
  const userData = await tempUserData(t);
  const calls: SecurityCall[] = [];
  const { log } = captureLog();
  const options = {
    userDataDir: userData,
    runtimeName: "vision",
    execFile: stubExecFile("not-found", calls),
    log,
    retirementApplied: retired,
    platform: "darwin" as const,
  };

  assert.equal(await cleanupLegacyAuditArtifacts(options), "completed");
  const folder = await seedReceiptFolder(userData);
  assert.equal(await cleanupLegacyAuditArtifacts(options), "skipped");
  assert.equal(calls.length, 1);
  assert.equal(await exists(folder), true);
});

test("skips the Keychain step off macOS and for runtimes without a witness", async (t) => {
  for (const [platform, runtimeName] of [
    ["linux", "vision"],
    ["win32", "vision_demo"],
    ["darwin", "vision_dev"],
  ] as const) {
    const userData = await tempUserData(t);
    const folder = await seedReceiptFolder(userData);
    const calls: SecurityCall[] = [];
    const { log } = captureLog();

    const result = await cleanupLegacyAuditArtifacts({
      userDataDir: userData,
      runtimeName,
      execFile: stubExecFile("ok", calls),
      log,
      retirementApplied: retired,
      platform,
    });

    assert.equal(result, "completed");
    assert.deepEqual(calls, []);
    assert.equal(await exists(folder), false);
    assert.equal(await exists(path.join(userData, MARKER)), true);
  }
});
