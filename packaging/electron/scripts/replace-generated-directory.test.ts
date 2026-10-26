import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { replaceGeneratedDirectory } from "./replace-generated-directory";

void test("generated directory activation atomically replaces complete content", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-generated-replace-"),
  );
  const destination = path.join(temp, "runtime");
  const staging = path.join(temp, "staging");
  try {
    await fs.promises.mkdir(destination);
    await fs.promises.writeFile(path.join(destination, "old"), "old");
    await fs.promises.mkdir(staging);
    await fs.promises.writeFile(path.join(staging, "new"), "new");
    const result = replaceGeneratedDirectory(staging, destination);
    assert.equal(result.destination, destination);
    assert.equal(
      await fs.promises.readFile(path.join(destination, "new"), "utf8"),
      "new",
    );
    await assert.rejects(fs.promises.access(path.join(destination, "old")));
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
