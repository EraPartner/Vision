import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installNativeUpdate } from "./native-update-installer";

void test("partial removal of the previous app never rolls back a launched update", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-update-cleanup-"),
  );
  const sourceApp = path.join(root, "source", "Vision.app");
  const destinationApp = path.join(root, "installed", "Vision.app");
  const originalRemove = fs.rmSync;
  try {
    for (const app of [sourceApp, destinationApp])
      fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(sourceApp, "executable"), "new");
    fs.writeFileSync(path.join(destinationApp, "executable"), "old");
    fs.rmSync = (target, options) => {
      if (String(target).includes(".Vision-update-backup-")) {
        fs.unlinkSync(path.join(String(target), "executable"));
        throw new Error("injected partial cleanup failure");
      }
      originalRemove(target, options);
    };
    const result = installNativeUpdate({
      sourceApp,
      destinationApp,
      hostPid: 99999999,
      spawnProcess: () => ({ status: 0 }),
    });
    assert.equal(result.status, "installed");
    assert.match(result.cleanupWarning ?? "", /cleanup failed/);
    assert.equal(
      fs.readFileSync(path.join(destinationApp, "executable"), "utf8"),
      "new",
    );
    assert.equal(
      fs
        .readdirSync(path.dirname(destinationApp))
        .some((name) => name.includes("failed")),
      false,
    );
  } finally {
    fs.rmSync = originalRemove;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
