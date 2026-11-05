#!/usr/bin/env bun
/** Fail closed when deciding whether the application CI may be skipped. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

export type Git = (...args: string[]) => string;

/** True when the full application pipeline must run for these paths. */
export function classify(
  paths: readonly string[],
  specialPaths: ReadonlySet<string> = new Set(),
): boolean {
  if (paths.length === 0) return true;
  for (const path of paths) {
    if (specialPaths.has(path)) return true;
    if (
      path.startsWith("docs/") ||
      (!path.includes("/") && path.endsWith(".md"))
    )
      continue;
    // The Swift app is compiled by the `swift` CI job, not the TypeScript tiers (ADR-269).
    if (path.startsWith("apps/native/")) continue;
    // Configuration, executables and unknown formats still run the full suite.
    if (
      (path.startsWith(".agents/") || path.startsWith(".codex/")) &&
      path.endsWith(".md")
    )
      continue;
    return true;
  }
  return false;
}

/** Paths whose change needs the macOS Swift build and tests (ADR-269). */
export function isSwiftPath(path: string): boolean {
  return (
    path.startsWith("apps/native/") ||
    path.startsWith("scripts/native-") ||
    path === "scripts/lib/nativeCodegen.ts"
  );
}

const defaultGit: Git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

function nulSeparated(output: string): string[] {
  return output.split("\0").slice(0, -1);
}

export function changedPaths(
  base: string,
  head: string,
  git: Git = defaultGit,
): string[] {
  if (!base || !head || base === "0".repeat(40))
    throw new Error("commit range is not resolvable");
  git("cat-file", "-e", `${base}^{commit}`);
  git("cat-file", "-e", `${head}^{commit}`);
  // Disable rename detection so both sides of a move are classified.
  return nulSeparated(
    git("diff", "--name-only", "--no-renames", "-z", base, head),
  );
}

export interface Classification {
  readonly code: boolean;
  readonly swift: boolean;
}

/** Classifies a commit range; any failure selects the full pipeline and the Swift build. */
export function classifyRange(
  base: string,
  head: string,
  git: Git = defaultGit,
): Classification {
  try {
    const paths = changedPaths(base, head, git);
    const special = new Set<string>();
    for (const ref of [base, head]) {
      for (const entry of git("ls-tree", "-rz", ref).split("\0")) {
        if (!entry) continue;
        const tab = entry.indexOf("\t");
        if (tab === -1) throw new Error(`unexpected ls-tree entry: ${entry}`);
        if (entry.slice(0, tab).split(/\s+/)[0] !== "100644")
          special.add(entry.slice(tab + 1));
      }
    }
    return {
      code: classify(paths, special),
      swift: paths.some(isSwiftPath),
    };
  } catch {
    return { code: true, swift: true };
  }
}

if (isEntrypoint(import.meta)) {
  const isPr = process.env.EVENT_NAME === "pull_request";
  const base = process.env[isPr ? "PR_BASE_SHA" : "PUSH_BEFORE"] ?? "";
  const head = process.env[isPr ? "PR_HEAD_SHA" : "PUSH_SHA"] ?? "";
  const { code, swift } = classifyRange(base, head);
  console.log(
    code
      ? "Full application pipeline."
      : "Documentation/instruction diff; focused checks remain required.",
  );
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  if (swift) console.log("Swift app changed: the macOS Swift job runs.");
  fs.appendFileSync(
    output,
    `code=${String(code)}\nswift=${String(swift)}\n`,
    "utf8",
  );
}
