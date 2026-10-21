/**
 * localStorage key registry enforcement: every raw localStorage key the
 * frontend reads or writes must be registered in lib/localStorage-keys.ts,
 * which decides what the backup frontend-state snapshot carries.
 *
 * No database connection required — all assertions are static / file-based.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "../../..");

describe("localStorage keys registry", () => {
  it("every localStorage.setItem/getItem call in frontend uses a registered key", () => {
    const frontendSrc = join(REPO_ROOT, "apps/frontend/src");
    const keysContent = readFileSync(
      join(frontendSrc, "lib/localStorage-keys.ts"),
      "utf8",
    );

    // Extract all string literals registered in LOCAL_STORAGE_KEYS
    const registeredKeys = new Set();
    const keyValueRe = /:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = keyValueRe.exec(keysContent)) !== null) {
      registeredKeys.add(m[1]);
    }

    // Also collect excluded keys
    const excludedContent =
      keysContent.match(/LOCAL_STORAGE_EXCLUDED_KEYS[\s\S]*?\]/)?.[0] ?? "";
    const excludedKeys = new Set();
    const excludedRe = /['"]([^'"]+)['"]/g;
    while ((m = excludedRe.exec(excludedContent)) !== null) {
      excludedKeys.add(m[1]);
    }

    const allKnownKeys = new Set([...registeredKeys, ...excludedKeys]);

    // Scan source files for raw localStorage string literals
    const sourceFiles = findTsFiles(frontendSrc);
    const unregisteredUsages = [];

    const usageRe = /localStorage\.[gs]etItem\s*\(\s*['"]([^'"]+)['"]/g;
    for (const file of sourceFiles) {
      if (file.endsWith("localStorage-keys.ts")) continue;
      const src = readFileSync(file, "utf8");
      usageRe.lastIndex = 0;
      while ((m = usageRe.exec(src)) !== null) {
        const key = m[1];
        if (!allKnownKeys.has(key)) {
          unregisteredUsages.push({ file: file.replace(frontendSrc, ""), key });
        }
      }
    }

    expect(
      unregisteredUsages,
      [
        "These localStorage keys are used in source but not registered in localStorage-keys.ts:",
        ...unregisteredUsages.map((u) => `  "${u.key}" in ${u.file}`),
        "Add them to LOCAL_STORAGE_KEYS or LOCAL_STORAGE_EXCLUDED_KEYS.",
      ].join("\n"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts / .tsx files under a directory.
 * Skips node_modules, dist, and .turbo.
 * @param {string} dir
 * @returns {string[]}
 */
function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo"
      )
        continue;
      results.push(...findTsFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      results.push(full);
    }
  }
  return results;
}
