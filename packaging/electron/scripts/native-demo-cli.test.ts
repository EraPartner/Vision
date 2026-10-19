import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./native-demo-cli";

test("Demo reset requires the explicit execute acknowledgement", () => {
  assert.deepEqual(parseArgs(["reset", "--execute"]), { command: "reset" });
  assert.throws(() => parseArgs(["reset"]), /Usage/);
  assert.throws(() => parseArgs(["reset", "--force"]), /Usage/);
});
