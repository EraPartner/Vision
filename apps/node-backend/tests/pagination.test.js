/**
 * lib/pagination.js — the opt-in half.
 *
 * parsePagination (always-on, with a default page size) is exercised through
 * the route tests that use it. These pin parseOptionalPagination, whose whole
 * job is to distinguish "the caller asked for a page" from "the caller wants
 * the collection": get that wrong and adding pagination to an established list
 * endpoint silently truncates every existing client.
 */
import { describe, expect, it } from 'vitest';
import { listBody, parseOptionalPagination } from '../src/lib/pagination.js';
import { buildLimitOffset } from '../src/lib/sqlClauses.js';

describe('parseOptionalPagination', () => {
  it('returns null when neither limit nor offset is present', () => {
    expect(parseOptionalPagination({}, { maxLimit: 1000 })).toBeNull();
    expect(parseOptionalPagination(undefined, { maxLimit: 1000 })).toBeNull();
    expect(parseOptionalPagination({ active: 'true' }, { maxLimit: 1000 })).toBeNull();
  });

  it('treats empty / null params as absent, not as "page zero"', () => {
    expect(parseOptionalPagination({ limit: '' }, { maxLimit: 1000 })).toBeNull();
    expect(parseOptionalPagination({ limit: null, offset: undefined }, { maxLimit: 1000 })).toBeNull();
  });

  it('parses a supplied pair', () => {
    expect(parseOptionalPagination({ limit: '10', offset: '20' }, { maxLimit: 1000 }))
      .toEqual({ limit: 10, offset: 20 });
  });

  it('defaults offset to 0 when only limit is given', () => {
    expect(parseOptionalPagination({ limit: '10' }, { maxLimit: 1000 }))
      .toEqual({ limit: 10, offset: 0 });
  });

  // "Everything from row N", not "the next 50" — an offset-only caller has not
  // asked for a small page, so the cap (not a page size) is the fallback.
  it('falls back to the cap when only offset is given', () => {
    expect(parseOptionalPagination({ offset: '5' }, { maxLimit: 1000 }))
      .toEqual({ limit: 1000, offset: 5 });
  });

  it('honours an explicit defaultLimit over the cap', () => {
    expect(parseOptionalPagination({ offset: '5' }, { defaultLimit: 50, maxLimit: 5000 }))
      .toEqual({ limit: 50, offset: 5 });
  });

  it('clamps to maxLimit and floors garbage/negative input', () => {
    expect(parseOptionalPagination({ limit: '999999' }, { maxLimit: 1000 }).limit).toBe(1000);
    expect(parseOptionalPagination({ limit: 'abc' }, { maxLimit: 1000 }).limit).toBe(1000);
    expect(parseOptionalPagination({ limit: '10', offset: '-4' }, { maxLimit: 1000 }).offset).toBe(0);
  });
});

describe('listBody', () => {
  it('omits limit/offset when the request did not paginate', () => {
    expect(listBody([1, 2], 2)).toEqual({ items: [1, 2], total: 2 });
  });

  it('carries the page cursor and the FULL total when it did', () => {
    expect(listBody([2], 9, { limit: 1, offset: 1 }))
      .toEqual({ items: [2], total: 9, limit: 1, offset: 1 });
  });
});

describe('buildLimitOffset', () => {
  it('adds nothing and touches no params when limit is null', () => {
    const params = ['x'];
    expect(buildLimitOffset(params, { limit: null })).toBe('');
    expect(params).toEqual(['x']);
  });

  it('numbers placeholders after the params already collected', () => {
    const params = ['x'];
    expect(buildLimitOffset(params, { limit: 5, offset: 10 })).toBe(' LIMIT $2 OFFSET $3');
    expect(params).toEqual(['x', 5, 10]);
  });
});
