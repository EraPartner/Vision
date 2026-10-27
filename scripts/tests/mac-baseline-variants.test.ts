import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseOptions } from "../mac-baseline.ts";
import { presentedFps, type TraceSegmentSummary } from "../lib/mac-baseline/trace.ts";
import {
  loadVariants,
  parseVariantSpec,
  parseVariantSpecs,
} from "../lib/mac-baseline/variants.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mac-baseline-variants-"));
}

void test("parses --variant name=file", () => {
  assert.deepEqual(parseVariantSpec("drift-20=a/b.css"), {
    name: "drift-20",
    file: "a/b.css",
  });
  // Only the first "=" separates; the rest belongs to the path.
  assert.deepEqual(parseVariantSpec("x1=dir/a=b.js"), {
    name: "x1",
    file: "dir/a=b.js",
  });
});

void test("rejects malformed variant specs", () => {
  for (const bad of ["nofile", "=x.css", "name=", "Upper=x.css", "a_b=x.css"]) {
    assert.throws(() => parseVariantSpec(bad), bad);
  }
  assert.throws(() => parseVariantSpec("base=x.css"), /implicit/);
  assert.throws(
    () => parseVariantSpecs(["a=x.css", "a=y.css"]),
    /given twice/,
  );
});

void test("loads variants with base first and validates files", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.css"), "html{}");
  fs.writeFileSync(path.join(dir, "b.js"), "1+1");
  fs.writeFileSync(path.join(dir, "c.txt"), "x");
  const variants = loadVariants(
    [`a=${path.join(dir, "a.css")}`, "b=b.js"],
    dir,
  );
  assert.deepEqual(
    variants.map((v) => [v.name, v.kind, v.content]),
    [
      ["base", "none", ""],
      ["a", "css", "html{}"],
      ["b", "js", "1+1"],
    ],
  );
  assert.throws(() => loadVariants(["m=missing.css"], dir), /not found/);
  assert.throws(() => loadVariants([`t=${path.join(dir, "c.txt")}`], dir), /\.css or \.js/);
});

void test("parseOptions wires variants and the idle flags", () => {
  const dir = tempDir();
  const file = path.join(dir, "v.css");
  fs.writeFileSync(file, "html{}");
  const base = ["--app", "/nonexistent.app"];

  const plain = parseOptions(base);
  assert.deepEqual(plain?.variants.map((v) => v.name), ["base"]);
  assert.equal(plain.variantsOnlyIdle, false);
  assert.equal(plain.idleTrace, true);

  const options = parseOptions([
    ...base,
    "--variant",
    `v1=${file}`,
    "--variant",
    `v2=${file}`,
    "--variants-only-idle",
    "--no-trace",
  ]);
  assert.deepEqual(options?.variants.map((v) => v.name), ["base", "v1", "v2"]);
  assert.equal(options.variantsOnlyIdle, true);
  assert.equal(options.trace, false);
  assert.equal(options.idleTrace, false);
  assert.equal(parseOptions([...base, "--no-trace", "--idle-trace"])?.idleTrace, true);
  assert.throws(
    () => parseOptions([...base, "--variant", "v=/does/not/exist.css"]),
    /not found/,
  );
});

void test("presentedFps counts presented frames from the busiest process", () => {
  const summary = {
    durationMs: 10_000,
    threadBusyMs: {},
    rendererTopEvents: [],
    frameStates: {
      "Renderer 1": { STATE_PRESENTED_ALL: 90, STATE_PRESENTED_PARTIAL: 10, STATE_DROPPED: 5 },
      "GPU Process 2": { STATE_PRESENTED_ALL: 100 },
    },
  } satisfies TraceSegmentSummary;
  assert.deepEqual(presentedFps(summary), {
    fps: 10,
    presentedFrames: 100,
    seconds: 10,
  });
  assert.equal(presentedFps({ ...summary, durationMs: 0 }).fps, 0);
});
