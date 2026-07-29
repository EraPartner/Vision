#!/usr/bin/env node
/**
 * checkJs `noImplicitAny` ratchet.
 *
 * `tsconfig.check.json` (the required CI gate) runs with `strict: false` and
 * `noImplicitAny: false`, so an unannotated parameter is a silent `any` and the
 * gate only catches gross misuse. Turning `noImplicitAny` on globally is not
 * something one change could pay for in one sitting, so it was ratcheted on
 * per file/directory instead — see RATCHETED below for how that campaign
 * finished: the whole `src/` tree is now held to noImplicitAny, permanently,
 * by a single prefix entry.
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
 * There is nothing left to ratchet: every file under `src/` is already held to
 * noImplicitAny via the single prefix entry below, and a newly created file
 * under `src/` is covered from birth — no per-file or per-directory addition
 * needed. If a future top-level sibling of `src/` appears (a second source
 * root outside it) and should also be held to noImplicitAny, add its own
 * prefix entry to RATCHETED the same way.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'tsconfig.check.strict.json');

/**
 * Paths whose implicit-any errors FAIL this check. Relative to
 * `apps/node-backend/`, POSIX separators. An entry ending in `/` is a directory
 * prefix; anything else is an exact file.
 *
 * Campaign complete: every file under `src/` (types, repositories, services,
 * routes, lib, middleware, controllers, integrations, startup, config, utils,
 * database, main.js) is implicit-any-clean, so the tree collapses to the
 * single `src/` prefix below. `isRatcheted`'s match is per-string-prefix, not
 * per-directory-level, so this one entry covers the whole tree, including any
 * new file added from birth — no per-directory or per-file entries needed
 * anymore. History, briefly: the data layer (`types/`, `repositories/`) went
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
const RATCHETED = [
  'src/',
];

/**
 * @param {string} absolutePath
 * @returns {string} POSIX path relative to apps/node-backend/
 */
function toRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isRatcheted(relativePath) {
  return RATCHETED.some((entry) =>
    entry.endsWith('/') ? relativePath.startsWith(entry) : relativePath === entry);
}

/**
 * @returns {ts.ParsedCommandLine}
 */
function loadConfig() {
  const host = {
    ...ts.sys,
    /** @param {ts.Diagnostic} diagnostic */
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      process.exit(2);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(CONFIG_PATH, undefined, host);
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
    if (rel.startsWith('..') || rel.includes('node_modules/')) continue;
    const bucket = byFile.get(rel);
    if (bucket) bucket.push(diagnostic);
    else byFile.set(rel, [diagnostic]);
  }

  const failures = [...byFile.entries()].filter(([rel]) => isRatcheted(rel));

  if (failures.length > 0) {
    const formatHost = {
      getCanonicalFileName: (/** @type {string} */ f) => f,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    };
    const flat = failures.flatMap(([, list]) => list);
    console.error(ts.formatDiagnostics(flat, formatHost).trimEnd());
    console.error('');
    console.error(
      `[checkjs-ratchet] FAIL: ${flat.length} error(s) in ${failures.length} ratcheted file(s).`,
    );
    console.error('[checkjs-ratchet] These paths are held to noImplicitAny — annotate, do not widen.');
    process.exit(1);
  }

  const ratchetedCount = [...program.getSourceFiles()]
    .map((sourceFile) => toRelative(sourceFile.fileName))
    .filter((rel) => !rel.startsWith('..') && isRatcheted(rel)).length;

  // No "ready to ratchet" hint anymore: RATCHETED is a single `src/` prefix,
  // so every in-scope file is either already ratcheted (and just got counted
  // above) or would have failed the check above already — there is no
  // clean-but-unlisted frontier left to surface.
  console.log(`[checkjs-ratchet] OK: ${ratchetedCount} file(s) clean under noImplicitAny.`);
}

main();
