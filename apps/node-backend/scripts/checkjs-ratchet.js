#!/usr/bin/env node
/**
 * checkJs `noImplicitAny` ratchet.
 *
 * `tsconfig.check.json` (the required CI gate) runs with `strict: false` and
 * `noImplicitAny: false`, so an unannotated parameter is a silent `any` and the
 * gate only catches gross misuse. Turning `noImplicitAny` on globally is not
 * something one change could pay for in one sitting, so it was ratcheted on
 * per file/directory instead — see RATCHETED below for how that campaign
 * finished: the whole `src/` tree is checked by a single prefix entry. The
 * baseline records later regressions, while any new diagnostic fails this gate.
 *
 * Why a filtering script instead of a second tsconfig scoped to a directory:
 * `tsc` has no per-directory strictness, and narrowing a config's `include` to
 * `src/repositories/**` does NOT produce a repositories-only check — tsc still
 * pulls every transitively imported module into the program and reports its
 * errors too (measured: 709 own + 204 transitive at the time this landed). It
 * also changes ambient type discovery: `@types/node` is not linked into
 * `node_modules/@types` in this bun workspace, so node globals only resolve via
 * a package reference that the narrowed program no longer reaches, and the
 * narrowed config invents ~17 bogus "Cannot find name 'process'" errors the
 * real gate never sees. Compiling the SAME program as the base config and
 * filtering diagnostics by path avoids both problems: one program, one module
 * resolution, no drift between the two gates. That reasoning is now moot for
 * `RATCHETED` itself (a single `src/` prefix needs no directory-scoped tsconfig
 * either way) but still explains why this script, rather than a second
 * tsconfig, is the CI gate for noImplicitAny.
 *
 * Usage: bun run typecheck:ratchet     (or: bun scripts/checkjs-ratchet.js)
 *
 * The baseline stores each existing diagnostic's file, code, message, and
 * trimmed source line. Repeated identical diagnostics are counted separately.
 * Remove entries as source is fixed; stale entries also fail the gate. Do not
 * add new entries to bypass a failure.
 * A new file under `src/` is covered without a per-file entry.
 */

import path from "node:path";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "tsconfig.check.strict.json");
const BASELINE_PATH = path.join(ROOT, "scripts/checkjs-ratchet-baseline.json");

/**
 * Paths whose implicit-any errors FAIL this check. Relative to
 * `apps/node-backend/`, POSIX separators. An entry ending in `/` is a directory
 * prefix; anything else is an exact file.
 *
 * The original annotation campaign covered every file under `src/`, so the
 * tree collapsed to the single prefix below. Later source changes introduced
 * diagnostics recorded in checkjs-ratchet-baseline.json. `isRatcheted` matches
 * by string prefix, so this entry covers the whole tree, including new files.
 * History, briefly: the data layer (`types/`, `repositories/`) went
 * first, then `services/` one subdirectory at a time (`calculations/` last),
 * then the non-routes backend tail (`lib/`, `middleware/`, `controllers/`,
 * `integrations/`, `startup/`, `config/`, `utils/`, `database/`, 272 errors
 * across 35 files in one slice), then `routes/` file-by-file largest-first
 * (unlike every directory above — the directory was 20+ files and far from
 * uniformly clean, so a whole-directory prefix would have gated a mix of
 * annotated and still-dirty files together until the last file landed) plus
 * `main.js`. Shared Express req/res/router structural types for the
 * post-data-layer files live in `src/types/express.js` — extended across the
 * campaign as new call sites needed members it lacked (`write`/`once`/`set`/
 * `sendFile`/`writeHead`/`getHeader`/`removeHeader`/`type`/`emit`, a
 * `ResponseMetaLoose` alias for `ok(data, meta)`'s second argument, and
 * `ExpressRequest.file.buffer` for multer memoryStorage uploads) rather than
 * casting per file — one shared surface for every route/middleware/controller
 * file instead of the report-generation one-offs `ExpressResponse` in
 * services/transactionExport.js and services/reports/index.js predate.
 * `express` itself joined `multer`/`pg` in `src/types/thirdPartyModules.d.ts`'s
 * ambient-module list partway through `routes/` (every route file does
 * `import { Router } from 'express'`, a VALUE import that trips TS7016 the
 * same way).
 *
 * @type {string[]}
 */
const RATCHETED = ["src/"];

/**
 * @param {string} absolutePath
 * @returns {string} POSIX path relative to apps/node-backend/
 */
function toRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join("/");
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isRatcheted(relativePath) {
  return RATCHETED.some((entry) =>
    entry.endsWith("/")
      ? relativePath.startsWith(entry)
      : relativePath === entry,
  );
}

/** @param {ts.Diagnostic} diagnostic */
function diagnosticKey(diagnostic) {
  const file = diagnostic.file;
  const start = diagnostic.start;
  if (!file || start === undefined) return undefined;
  const rel = toRelative(file.fileName);
  const line = file.getLineAndCharacterOfPosition(start).line;
  const sourceLine = file.text.split(/\r?\n/)[line]?.trim() ?? "";
  return JSON.stringify([
    rel,
    diagnostic.code,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    sourceLine,
  ]);
}

function loadBaseline() {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 4 &&
        typeof item[0] === "string" &&
        typeof item[1] === "number" &&
        typeof item[2] === "string" &&
        typeof item[3] === "string",
    )
  ) {
    throw new Error(`[checkjs-ratchet] Invalid baseline: ${BASELINE_PATH}`);
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of parsed) {
    const key = JSON.stringify(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * @returns {ts.ParsedCommandLine}
 */
function loadConfig() {
  const host = {
    ...ts.sys,
    /** @param {ts.Diagnostic} diagnostic */
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      console.error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
      process.exit(2);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    CONFIG_PATH,
    undefined,
    host,
  );
  if (!parsed) {
    console.error(`[checkjs-ratchet] could not read ${CONFIG_PATH}`);
    process.exit(2);
  }
  return parsed;
}

function main() {
  const parsed = loadConfig();
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  /** @type {Map<string, ts.Diagnostic[]>} */
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.file) continue;
    const rel = toRelative(diagnostic.file.fileName);
    if (rel.startsWith("..") || rel.includes("node_modules/")) continue;
    const bucket = byFile.get(rel);
    if (bucket) bucket.push(diagnostic);
    else byFile.set(rel, [diagnostic]);
  }

  const baseline = loadBaseline();
  const ratcheted = [...byFile.entries()].filter(([rel]) => isRatcheted(rel));
  const failures = ratcheted
    .flatMap(([, list]) => list)
    .filter((diagnostic) => {
      const key = diagnosticKey(diagnostic);
      if (!key) return true;
      const remaining = baseline.get(key) ?? 0;
      if (remaining === 0) return true;
      baseline.set(key, remaining - 1);
      return false;
    });

  if (failures.length > 0) {
    const formatHost = {
      getCanonicalFileName: (/** @type {string} */ f) => f,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => "\n",
    };
    console.error(ts.formatDiagnostics(failures, formatHost).trimEnd());
    console.error("");
    console.error(
      `[checkjs-ratchet] FAIL: ${failures.length} new diagnostic(s) in ratcheted source.`,
    );
    console.error(
      "[checkjs-ratchet] Fix new diagnostics; the baseline records existing debt only.",
    );
    process.exit(1);
  }

  const ratchetedCount = [...program.getSourceFiles()]
    .map((sourceFile) => toRelative(sourceFile.fileName))
    .filter((rel) => !rel.startsWith("..") && isRatcheted(rel)).length;

  // The single src/ prefix also covers newly added files. Require baseline
  // entries to be pruned when their diagnostics are fixed, so reintroducing an
  // old error cannot consume a stale entry later.
  const resolved = [...baseline.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  if (resolved > 0) {
    console.error(
      `[checkjs-ratchet] FAIL: ${resolved} stale baseline diagnostic(s). Remove their entries from ${BASELINE_PATH}.`,
    );
    process.exit(1);
  }
  console.log(
    `[checkjs-ratchet] OK: ${ratchetedCount} source file(s) checked; no new or stale diagnostics.`,
  );
}

main();
