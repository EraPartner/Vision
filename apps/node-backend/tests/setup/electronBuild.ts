import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Backend tests load compiled Electron modules (backup bundle, settings
// conflicts) from packaging/electron/out/ (ADR-196). Build once per run, and
// only when a source is newer than the last build.
const electronRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packaging",
  "electron",
);
const stamp = path.join(electronRoot, "out", ".built");
const SKIP = new Set([
  "node_modules",
  "out",
  "dist",
  "dist-demo",
  "native-runtime",
]);

function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else if (/\.(c|m)?(t|j)s$|^tsconfig.*\.json$/.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

export default function setup(): void {
  if (!fs.existsSync(path.join(electronRoot, "package.json"))) return;
  const built = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
  if (built >= newestSourceMtime(electronRoot)) return;
  const result = spawnSync("bun", [path.join(electronRoot, "build.ts")], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      "Electron build failed; backend tests that load packaging/electron/out cannot run",
    );
  }
}
