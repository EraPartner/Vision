/**
 * Smoke test for the shared DB test-fixture helper.
 *
 * The helper itself is inert without TEST_DATABASE_URL; these cases only
 * verify the resolution semantics so future DB-bound suites can rely on them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getTestPool, hasTestDatabase, closeTestPool } from './db.js';

const originalUrl = process.env.TEST_DATABASE_URL;

afterEach(async () => {
  await closeTestPool();
  if (originalUrl === undefined) {
    delete process.env.TEST_DATABASE_URL;
  } else {
    process.env.TEST_DATABASE_URL = originalUrl;
  }
});

describe('tests/setup/db', () => {
  it('returns null when TEST_DATABASE_URL is unset', () => {
    delete process.env.TEST_DATABASE_URL;
    expect(getTestPool()).toBeNull();
    expect(hasTestDatabase()).toBe(false);
  });

  it('hasTestDatabase reflects env presence without opening a pool', () => {
    process.env.TEST_DATABASE_URL = 'postgres://example';
    expect(hasTestDatabase()).toBe(true);
  });
});
