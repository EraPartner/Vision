"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseArgs } = require("./native-demo-cli");

test("Demo reset requires the explicit execute acknowledgement", () => {
  assert.deepEqual(parseArgs(["reset", "--execute"]), { command: "reset" });
  assert.throws(() => parseArgs(["reset"]), /Usage/);
  assert.throws(() => parseArgs(["reset", "--force"]), /Usage/);
});
