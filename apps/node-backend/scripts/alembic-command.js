#!/usr/bin/env bun
/** Run read-only or authoring Alembic commands with a host-valid executable. */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const allowedCommands = new Set(["current", "heads", "history", "revision"]);

if (!allowedCommands.has(args[0])) {
  console.error(
    "Usage: alembic-command.js <current|heads|history|revision> [arguments...]",
  );
  process.exit(1);
}

const candidates = [];
if (process.env.ALEMBIC_BIN) candidates.push(process.env.ALEMBIC_BIN);
if (process.env.VISION_PYTHON_BIN) {
  candidates.push(
    path.join(path.dirname(process.env.VISION_PYTHON_BIN), "alembic"),
  );
}
candidates.push(
  path.join(repoRoot, ".venv-native-build", "bin", "alembic"),
  path.join(
    repoRoot,
    "packaging",
    "electron",
    "native-runtime",
    "vision-alembic",
  ),
  path.join(repoRoot, "venv", "bin", "alembic"),
  "alembic",
);

let executable;
for (const candidate of candidates) {
  if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) {
    executable = candidate;
    break;
  }
}

if (!executable) {
  console.error(
    "[alembic-command] no runnable Alembic found; set ALEMBIC_BIN or install config/requirements.txt",
  );
  process.exit(1);
}

const config =
  process.env.ALEMBIC_CONFIG ?? path.join(repoRoot, "config", "alembic.ini");
const result = spawnSync(executable, ["-c", config, ...args], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) {
  console.error(`[alembic-command] ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
