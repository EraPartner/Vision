#!/usr/bin/env node
/**
 * checkJs `noImplicitAny` ratchet.
 *
 * `tsconfig.check.json` (the required CI gate) runs with `strict: false` and
 * `noImplicitAny: false`, so an unannotated parameter is a silent `any` and the
 * gate only catches gross misuse. Turning `noImplicitAny` on globally is not
 * something one change can pay for, so it is ratcheted on per file instead:
 * every path in RATCHETED below must stay free of implicit-any errors, and the
 * list only ever grows.
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
 * resolution, no drift between the two gates.
 *
 * Usage: bun run typecheck:ratchet     (or: bun scripts/checkjs-ratchet.js)
 *
 * To ratchet another file: annotate it until it appears under "ready to
 * ratchet" in this script's output, then add its path to RATCHETED.
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
 * Seeded with the core data-layer row shapes (`src/types/rows.js`), then grown
 * file-by-file until every repository was annotated. The whole data layer is
 * now held as directory prefixes, so a NEW file under either directory is
 * ratcheted from birth.
 *
 * `src/services/` is being taken the same way, one whole subdirectory at a
 * time: a subdirectory is annotated to zero errors and only then added here as
 * a prefix, so new files under it are ratcheted from birth too. Held so far as
 * prefixes: the two import pipelines, currency/FX, prices, tax, and info.
 *
 * The top level of `src/services/` (all 51 `*.js` files directly in that
 * directory, not its subdirectories) is now fully held — but still as 51
 * individual file paths, not a `src/services/` prefix: `isRatcheted`'s prefix
 * match is per-string-prefix, not per-directory-level, so a `src/services/`
 * entry would ALSO match every still-dirty subdirectory below (`aiChat/` and
 * most of `calculations/`/`research/`/`reports/`/`portfolio/`) and gate them
 * sight-unseen — instant CI failure on this script's next run. Collapsing the
 * 51 entries to a directory prefix is only safe once those subdirectories are
 * themselves fully clean (at which point `src/services/` alone, without the
 * now-redundant subdirectory prefixes, would cover the whole tree).
 *
 * `calculations/`, `research/`, `reports/`, and `portfolio/` are each
 * individually-clean-file-only so far (not yet whole subdirectories) — most
 * of those directories are still implicit-any-dirty. `aiChat/` is untouched.
 * Beyond services: `routes/` and `lib/` are untouched.
 *
 * @type {string[]}
 */
const RATCHETED = [
  'src/types/',
  'src/repositories/',
  'src/services/currency/',
  'src/services/importPipeline/',
  'src/services/info/',
  'src/services/portfolioImportPipeline/',
  'src/services/prices/',
  'src/services/tax/',

  // calculations/, research/, reports/, portfolio/ — individually-clean files
  // only; the directories themselves are still mostly implicit-any-dirty.
  'src/services/calculations/aggregation/_envelope.js',
  'src/services/calculations/aggregation/_statisticsCache.js',
  'src/services/calculations/aggregation/averageVsCurrent.js',
  'src/services/calculations/aggregation/bankBalances.js',
  'src/services/calculations/aggregation/category.js',
  'src/services/calculations/forecast/methods/ensemble.js',
  'src/services/calculations/forecast/methods/simpleAverage.js',
  'src/services/calculations/normalization.js',
  'src/services/portfolio/portfolioIncomeService.js',
  'src/services/reports/dataFetcherPortfolio.js',
  'src/services/reports/sectionCatalog.js',
  'src/services/research/adapters/schemas.js',
  'src/services/research/providerRegistry.js',

  // Top level of src/services/ — all 51 files, alphabetical.
  'src/services/accountMergeService.js',
  'src/services/accountService.js',
  'src/services/aggregationRefresh.js',
  'src/services/aiChatService.js',
  'src/services/attachmentCleanup.js',
  'src/services/attachmentRecordService.js',
  'src/services/attachmentService.js',
  'src/services/bankAdapters.js',
  'src/services/belgianInflationService.js',
  'src/services/bulkSelection.js',
  'src/services/cashForecastInsightService.js',
  'src/services/categoryOutlierService.js',
  'src/services/categoryService.js',
  'src/services/crossWorkspaceAnalytics.js',
  'src/services/crossWorkspaceDataService.js',
  'src/services/customParserConfigService.js',
  'src/services/dataImportService.js',
  'src/services/dbEditor.js',
  'src/services/deduplication.js',
  'src/services/importBatchService.js',
  'src/services/infoService.js',
  'src/services/insightsDigestService.js',
  'src/services/marketLookupService.js',
  'src/services/materializedViewService.js',
  'src/services/openingBalanceService.js',
  'src/services/plannedExecutionService.js',
  'src/services/plannedMatchService.js',
  'src/services/plannedTransactionService.js',
  'src/services/portfolioImportBatchService.js',
  'src/services/portfolioPerformanceSnapshotService.js',
  'src/services/priceProviderService.js',
  'src/services/providerHealthService.js',
  'src/services/quoteBackfillService.js',
  'src/services/recipientBankAccountService.js',
  'src/services/recipientClusterService.js',
  'src/services/recipientMergeService.js',
  'src/services/recipientPatternService.js',
  'src/services/recipientService.js',
  'src/services/reconcileService.js',
  'src/services/recurringDetectionService.js',
  'src/services/routeManifest.js',
  'src/services/savedChartsService.js',
  'src/services/settingsService.js',
  'src/services/splitService.js',
  'src/services/subscriptionCreepService.js',
  'src/services/tagService.js',
  'src/services/transactionBulkService.js',
  'src/services/transactionExport.js',
  'src/services/transactionService.js',
  'src/services/transferReconciliationService.js',
  'src/services/watchlistService.js',
];

/**
 * Directory the "ready to ratchet" hint scans for already-clean files. Points
 * at the frontier: `src/repositories/` is complete, so the hint now surfaces
 * service files that are already implicit-any-clean and could be listed.
 */
const HINT_SCOPE = 'src/services/';

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

  const ready = [...program.getSourceFiles()]
    .map((sourceFile) => toRelative(sourceFile.fileName))
    .filter((rel) => rel.startsWith(HINT_SCOPE) && !isRatcheted(rel) && !byFile.has(rel))
    .sort();

  console.log(`[checkjs-ratchet] OK: ${ratchetedCount} file(s) clean under noImplicitAny.`);
  if (ready.length > 0) {
    console.log('[checkjs-ratchet] ready to ratchet (already clean, not yet listed):');
    for (const rel of ready) console.log(`  ${rel}`);
  }
}

main();
