import assert from "node:assert/strict";
import type { SpawnSyncOptions } from "node:child_process";
import test from "node:test";

import { ensureChromiumSource } from "./prepare-development-runtime";

test("development runtime installs only the pinned browser with argument arrays", () => {
  const calls: {
    executable: string;
    args: string[];
    options: SpawnSyncOptions;
  }[] = [];
  let discovered = false;
  const source = ensureChromiumSource({
    findSource: () => {
      if (!discovered) {
        discovered = true;
        throw new Error("missing");
      }
      return "/tmp/chrome-headless-shell";
    },
    hasPuppeteer: () => true,
    spawn: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0 };
    },
  });

  assert.equal(source, "/tmp/chrome-headless-shell");
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.deepEqual(call.args, [
    "browsers",
    "install",
    "chrome-headless-shell@150.0.7871.24",
  ]);
  assert.equal(call.options.shell, undefined);
});
