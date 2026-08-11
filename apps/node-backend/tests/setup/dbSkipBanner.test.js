/**
 * The banner is the guard against mistaking a DB-less run for a complete one,
 * so a guard that silently stops firing is worse than no guard at all. These
 * cases pin both halves: it fires when DB-backed cases were skipped for want of
 * a database, and it stays quiet when TEST_DATABASE_URL is set.
 */

import { describe, expect, it } from 'vitest';
import { collectDbSkips, createDbSkipBannerReporter, formatDbSkipBanner } from './dbSkipBanner.js';

/**
 * Minimal stand-in for a vitest TestModule.
 * @param {string} moduleId
 * @param {{ skipped?: number, passed?: number }} counts
 */
function fakeModule(moduleId, { skipped = 0, passed = 0 } = {}) {
  return {
    moduleId,
    children: {
      *allTests(state) {
        const total = state === 'skipped' ? skipped : skipped + passed;
        for (let i = 0; i < total; i += 1) yield { name: `${moduleId}#${i}` };
      },
    },
  };
}

const dbBacked = (moduleId) => moduleId.includes('.db.');

describe('collectDbSkips', () => {
  it('counts only skipped cases that live behind the DB seam', () => {
    const modules = [
      fakeModule('a.db.test.js', { skipped: 12 }),
      fakeModule('b.db.test.js', { skipped: 3, passed: 4 }),
      fakeModule('c.test.js', { skipped: 2, passed: 9 }),
      fakeModule('d.test.js', { passed: 40 }),
    ];

    expect(collectDbSkips(modules, dbBacked)).toEqual({
      skippedTests: 15,
      skippedFiles: 2,
      totalSkipped: 17,
    });
  });

  it('reports nothing for a run with no skips', () => {
    const counts = collectDbSkips([fakeModule('a.db.test.js', { passed: 5 })], dbBacked);
    expect(counts).toEqual({ skippedTests: 0, skippedFiles: 0, totalSkipped: 0 });
  });

  it('recognises the real seam by its import, not by the filename', () => {
    // services/aggregationRefresh.test.js is DB-backed without a .db. in its name.
    const real = new URL('../services/aggregationRefresh.test.js', import.meta.url).pathname;
    const plain = new URL('./dbSkipBanner.test.js', import.meta.url).pathname;
    const counts = collectDbSkips([
      fakeModule(real, { skipped: 6 }),
      fakeModule(plain, { skipped: 1 }),
    ]);
    expect(counts).toEqual({ skippedTests: 6, skippedFiles: 1, totalSkipped: 7 });
  });

  it('survives a module whose children cannot be walked', () => {
    const broken = { moduleId: 'x.db.test.js', children: undefined };
    expect(collectDbSkips([broken], dbBacked).skippedTests).toBe(0);
  });
});

describe('formatDbSkipBanner', () => {
  it('states the counts it was given and the command to run', () => {
    const text = formatDbSkipBanner({ skippedTests: 378, skippedFiles: 27 });
    expect(text).toContain('378 DB-backed tests across 27 files were SKIPPED');
    expect(text).toContain('bun run test:db');
    expect(text).toContain('TEST_DATABASE_URL');
  });

  it('singularises a one-file run', () => {
    expect(formatDbSkipBanner({ skippedTests: 4, skippedFiles: 1 })).toContain('1 file were');
  });
});

describe('createDbSkipBannerReporter', () => {
  const modules = [fakeModule('a.db.test.js', { skipped: 9 })];

  function capture(env) {
    const written = [];
    const reporter = createDbSkipBannerReporter({
      env,
      write: (text) => written.push(text),
      color: false,
    });
    reporter.onTestRunEnd(modules.map((m) => ({ ...m, moduleId: seamPath(m.moduleId) })));
    return written.join('');
  }

  // Point the fake modules at a file that really imports the seam so the
  // reporter's own detection runs, rather than an injected predicate.
  const seamPath = () => new URL('../services/aggregationRefresh.test.js', import.meta.url).pathname;

  it('fires when TEST_DATABASE_URL is unset', () => {
    expect(capture({})).toContain('INCOMPLETE RUN -- 9 DB-backed tests');
  });

  it('stays silent when TEST_DATABASE_URL is set', () => {
    expect(capture({ TEST_DATABASE_URL: 'postgres://example/db' })).toBe('');
  });

  it('stays silent when nothing DB-backed was skipped', () => {
    const written = [];
    const reporter = createDbSkipBannerReporter({
      env: {},
      write: (text) => written.push(text),
      color: false,
    });
    reporter.onTestRunEnd([fakeModule('plain.test.js', { skipped: 3 })]);
    expect(written.join('')).toBe('');
  });
});
