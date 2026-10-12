import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main, parseArgs } from "./native-demo-cli";

test("Demo reset requires the explicit execute acknowledgement", () => {
  assert.deepEqual(parseArgs(["reset", "--execute"]), {
    command: "reset",
    target: "vision-demo",
  });
  assert.throws(() => parseArgs(["reset"]), /Usage/);
  assert.throws(() => parseArgs(["reset", "--force"]), /Usage/);
});

test("Demo reset targets only the known Demo-data apps", () => {
  assert.deepEqual(
    parseArgs(["reset", "--execute", "--target", "vision-native-demo"]),
    { command: "reset", target: "vision-native-demo" },
  );
  assert.deepEqual(
    parseArgs(["reset", "--execute", "--target", "vision-native"]),
    { command: "reset", target: "vision-native" },
  );
  assert.throws(
    () => parseArgs(["reset", "--execute", "--target", "vision"]),
    /Usage/,
  );
  assert.throws(
    () => parseArgs(["reset", "--execute", "--target", "toString"]),
    /Usage/,
  );
  assert.throws(() => parseArgs(["reset", "--execute", "--target"]), /Usage/);
  assert.throws(
    () => parseArgs(["reset", "--target", "vision-native-demo", "--execute"]),
    /Usage/,
  );
});

test("Demo reset writes the request into the Vision Native Demo directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vision-demo-cli-"));
  const log = console.log;
  console.log = () => {};
  try {
    await main({
      argv: ["reset", "--execute", "--target", "vision-native-demo"],
      homeDir: home,
    });
  } finally {
    console.log = log;
  }
  const request = path.join(
    home,
    "Library",
    "Application Support",
    "Vision Native Demo",
    "demo-reset-request.json",
  );
  const parsed = JSON.parse(fs.readFileSync(request, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(fs.statSync(request).mode & 0o777, 0o600);
  assert.equal(
    fs.existsSync(
      path.join(home, "Library", "Application Support", "Vision Demo"),
    ),
    false,
  );
  fs.rmSync(home, { recursive: true, force: true });
});
