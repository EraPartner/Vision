import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atomicReplaceDirectory,
  rollbackDirectorySwitch,
  type DirectorySwitchToken,
} from "./native";

for (const phase of ["before", "between", "after"] as const) {
  void test(`attachment journal recovers ${phase} rename interruption repeatedly`, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "vision-attachment-journal-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const live = path.join(root, "attachments");
    await fs.mkdir(source);
    await fs.mkdir(live);
    await fs.writeFile(path.join(source, "receipt"), "new");
    await fs.writeFile(path.join(live, "receipt"), "old");
    let token: DirectorySwitchToken | undefined;
    await assert.rejects(
      atomicReplaceDirectory(source, live, {
        preservePrevious: true,
        beforeSwitch: async (plan) => {
          token = plan;
          assert.equal(
            await fs.readFile(path.join(live, "receipt"), "utf8"),
            "old",
          );
          throw new Error("interrupted after durable intent");
        },
      }),
      /durable intent/,
    );
    assert.ok(token?.previousDirectory);
    if (phase !== "before") await fs.rename(live, token.previousDirectory);
    if (phase === "after") await fs.cp(source, live, { recursive: true });
    await rollbackDirectorySwitch(token);
    assert.equal(await fs.readFile(path.join(live, "receipt"), "utf8"), "old");
    await rollbackDirectorySwitch(token);
    assert.equal(await fs.readFile(path.join(live, "receipt"), "utf8"), "old");
  });
}
