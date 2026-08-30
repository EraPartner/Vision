"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ensureChromiumSource } = require("./prepare-development-runtime");

test("development runtime installs only the pinned browser with argument arrays", () => {
  const calls = [];
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
  assert.deepEqual(calls[0].args, [
    "browsers",
    "install",
    "chrome-headless-shell@150.0.7871.24",
  ]);
  assert.equal(calls[0].options.shell, undefined);
});
