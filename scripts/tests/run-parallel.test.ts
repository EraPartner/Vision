/** Behaviour the `lint` and `test:all` scripts rely on (ADR-245). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../run-parallel.ts";

const script = path.join(import.meta.dirname, "..", "run-parallel.ts");
const run = (...args: string[]) =>
  spawnSync("bun", [script, ...args], { encoding: "utf8" });

test("parses flags and name=command pairs", () => {
  assert.deepEqual(parseArgs(["--group", "a=echo x=y", "b=true"]), {
    group: true,
    killOthersOnFail: false,
    tasks: [
      { name: "a", command: "echo x=y" },
      { name: "b", command: "true" },
    ],
  });
  assert.throws(() => parseArgs(["echo"]), /name=command/);
  assert.throws(() => parseArgs([]), /no commands/);
});

test("prefixes output and succeeds when every command succeeds", () => {
  const result = run("one=echo hello", "two=echo world");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\[one\] hello$/m);
  assert.match(result.stdout, /^\[two\] world$/m);
});

test("--group prints output in argument order", () => {
  const result = run("--group", "slow=sleep 0.3; echo first", "fast=echo second");
  assert.equal(result.status, 0);
  assert.ok(result.stdout.indexOf("first") < result.stdout.indexOf("second"));
});

test("a failing command fails the run and can stop the others", () => {
  const started = Date.now();
  const result = run(
    "--kill-others-on-fail",
    "bad=exit 3",
    "long=sleep 20; echo finished",
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /finished/);
  assert.ok(Date.now() - started < 10_000);
});
