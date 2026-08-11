/**
 * Vitest reporter: shout when a run silently omitted the DB-backed suites.
 *
 * `tests/setup/db.js` is opt-in — without TEST_DATABASE_URL every case behind
 * that seam self-skips. Vitest reports the result as "N passed | M skipped" and
 * exits 0, which reads as routine rather than as "a fifth of the DB-touching
 * surface was never exercised". A green local suite is then mistaken for a
 * green CI, where TEST_DATABASE_URL is always set.
 *
 * This reporter prints a loud banner AFTER the summary (the last thing a human
 * reads) whenever DB-backed cases were skipped for want of a database. It stays
 * silent when TEST_DATABASE_URL is set, so `bun run test:db` and CI are clean.
 *
 * Counts come from the run itself, never from a constant — a hardcoded figure
 * drifts the moment a suite is added.
 */

import { readFileSync } from 'node:fs';

// The seam is always imported directly ('./setup/db.js' / '../setup/db.js'),
// so a source-level match is enough to tell a DB-backed module from one that
// skipped for an unrelated reason (todo, platform gate, it.skip).
const DB_SEAM_IMPORT = /from\s*['"][^'"]*setup\/db\.js['"]/;

const SEPARATOR = '='.repeat(78);

/**
 * @param {string} moduleId
 * @param {Map<string, boolean>} cache
 * @returns {boolean}
 */
function importsDbSeam(moduleId, cache) {
  const cached = cache.get(moduleId);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    result = DB_SEAM_IMPORT.test(readFileSync(moduleId, 'utf8'));
  } catch {
    result = false;
  }
  cache.set(moduleId, result);
  return result;
}

/**
 * Count skipped cases that live behind the DB seam.
 *
 * @param {Iterable<any>} testModules vitest TestModule objects
 * @param {(moduleId: string) => boolean} [isDbBacked]
 * @returns {{ skippedTests: number, skippedFiles: number, totalSkipped: number }}
 */
export function collectDbSkips(testModules, isDbBacked) {
  const cache = new Map();
  const dbBacked = isDbBacked ?? ((moduleId) => importsDbSeam(moduleId, cache));

  let skippedTests = 0;
  let skippedFiles = 0;
  let totalSkipped = 0;

  for (const testModule of testModules ?? []) {
    let moduleSkipped = 0;
    try {
      for (const _test of testModule.children.allTests('skipped')) moduleSkipped += 1;
    } catch {
      moduleSkipped = 0;
    }
    if (moduleSkipped === 0) continue;
    totalSkipped += moduleSkipped;
    if (!dbBacked(testModule.moduleId)) continue;
    skippedTests += moduleSkipped;
    skippedFiles += 1;
  }

  return { skippedTests, skippedFiles, totalSkipped };
}

/**
 * @param {{ skippedTests: number, skippedFiles: number }} counts
 * @param {boolean} [color]
 * @returns {string}
 */
export function formatDbSkipBanner({ skippedTests, skippedFiles }, color = false) {
  const bold = color ? '\u001B[1;31m' : '';
  const dim = color ? '\u001B[31m' : '';
  const reset = color ? '\u001B[0m' : '';
  const files = skippedFiles === 1 ? 'file' : 'files';

  return [
    '',
    `${bold}${SEPARATOR}${reset}`,
    `${bold}  INCOMPLETE RUN -- ${skippedTests} DB-backed tests across ${skippedFiles} ${files} were SKIPPED${reset}`,
    `${bold}${SEPARATOR}${reset}`,
    `${dim}  TEST_DATABASE_URL is not set, so every case behind the tests/setup/db.js${reset}`,
    `${dim}  seam self-skipped. This run did NOT exercise them, and is NOT equivalent${reset}`,
    `${dim}  to CI's "Test (Backend)" job -- green here does not mean green there.${reset}`,
    '',
    `${bold}  Run "bun run test:db" before trusting this result.${reset}`,
    `${bold}${SEPARATOR}${reset}`,
    '',
  ].join('\n');
}

/**
 * Build the reporter. Appended to vitest's own reporter list (see
 * vitest.config.js) so it runs after the default reporter has printed its
 * summary.
 *
 * @param {{ env?: NodeJS.ProcessEnv, write?: (text: string) => void, color?: boolean }} [options]
 */
export function createDbSkipBannerReporter(options = {}) {
  const env = options.env ?? process.env;
  // stdout, not stderr: the summary this banner must follow is written to
  // stdout, and interleaving two streams through a pipe loses that ordering.
  const write = options.write ?? ((text) => process.stdout.write(text));
  const color =
    options.color ??
    (!env.NO_COLOR && (Boolean(env.FORCE_COLOR) || Boolean(process.stdout.isTTY)));

  return {
    isDbSkipBanner: true,
    onTestRunEnd(testModules) {
      if (env.TEST_DATABASE_URL) return;
      const counts = collectDbSkips(testModules);
      if (counts.skippedTests === 0) return;
      write(formatDbSkipBanner(counts, color));
    },
  };
}
