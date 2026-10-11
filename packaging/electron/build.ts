#!/usr/bin/env bun
// Compiles the Electron shell's TypeScript into out/ (ADR-196). Every launch,
// test and packaging path runs this first. out/ is rebuilt from scratch so a
// deleted source never leaves a stale module behind.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const electronRoot = import.meta.dirname;
const tsc = path.resolve(
  electronRoot,
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

fs.rmSync(path.join(electronRoot, "out"), { recursive: true, force: true });
for (const project of ["tsconfig.json", "tsconfig.preload.json"]) {
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", path.join(electronRoot, project)],
    {
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
// Build stamp: test harnesses compare it with source mtimes to skip a rebuild.
fs.writeFileSync(path.join(electronRoot, "out", ".built"), "");
