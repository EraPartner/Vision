/**
 * filterBuilder tests.
 *
 * Covers: validateInt4Ids, buildTransactionWhere, buildExclusionClauses,
 *         buildAggregationFilter. Param-index sharing is exercised so callers
 *         can compose these into larger queries without collision.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTransactionWhere,
  buildExclusionClauses,
  buildAggregationFilter,
  validateInt4Ids,
} from '../src/services/filterBuilder.js';

describe('validateInt4Ids', () => {
  it('keeps valid positive int4 ids', () => {
    expect(validateInt4Ids([1, 42, 2147483646])).toEqual([1, 42, 2147483646]);
  });

  it('drops null, undefined, non-integer, zero, negative, and overflow', () => {
    const raw = [null, undefined, '5', 1.5, 0, -1, 2147483647, NaN, 7];
    expect(validateInt4Ids(raw)).toEqual([7]);
  });

  it('returns empty array for non-array input', () => {
    expect(validateInt4Ids(null)).toEqual([]);
    expect(validateInt4Ids(undefined)).toEqual([]);
    expect(validateInt4Ids('42')).toEqual([]);
  });
});

describe('buildTransactionWhere', () => {
  it('defaults to active-only filter when given no options', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere();
    expect(sql).toBe('1=1 AND t.is_active = true');
    expect(params).toEqual([]);
    expect(nextParamIdx).toBe(1);
  });

  it('omits active clause when active=false', () => {
    const { sql } = buildTransactionWhere({ active: false });
    expect(sql).toBe('1=1');
  });

  it('builds date-range + bank-account filter with sequential $-indices', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      bankAccount: 'BE12',
    });
    expect(sql).toContain('t.date >= $1');
    expect(sql).toContain('t.date <= $2');
    expect(sql).toContain('t.bank_account ILIKE $3');
    expect(params).toEqual(['2026-01-01', '2026-01-31', '%BE12%']);
    expect(nextParamIdx).toBe(4);
  });

  it('categoryId uses the COALESCE chain over txn / recipient / primary defaults', () => {
    const { sql, params } = buildTransactionWhere({ categoryId: 9 });
    expect(sql).toContain(
      'COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = $1',
    );
    expect(params).toEqual([9]);
  });

  it('recipientId matches both direct and primary-recipient children', () => {
    const { sql, params } = buildTransactionWhere({ recipientId: 5 });
    expect(sql).toContain('(t.recipient_id = $1 OR r.primary_recipient_id = $1)');
    expect(params).toEqual([5]);
  });

  it('search parameter is referenced by every LIKE column with a single $-slot', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ search: 'groceries' });
    // Every column reuses $1 (single bound value).
    expect(sql.match(/\$1/g)).not.toBeNull();
    expect(sql).toContain('t.memo ILIKE $1');
    expect(sql).toContain('pc.detail ILIKE $1');
    expect(params).toEqual(['%groceries%']);
    expect(nextParamIdx).toBe(2);
  });

  it('respects startParamIdx so it can be composed into a bigger query', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      startDate: '2026-01-01',
      startParamIdx: 5,
    });
    expect(sql).toContain('t.date >= $5');
    expect(params).toEqual(['2026-01-01']);
    expect(nextParamIdx).toBe(6);
  });
});

describe('buildExclusionClauses', () => {
  it('returns empty whereSql and no params when exclusions are absent', () => {
    const result = buildExclusionClauses();
    expect(result.whereSql).toBe('');
    expect(result.params).toEqual([]);
    expect(result.nextParamIdx).toBe(1);
    expect(result.joinSql).toContain('LEFT JOIN recipients r');
    expect(result.joinSql).toContain('LEFT JOIN recipients pr');
  });

  it('drops invalid ids and only emits the clause if valid ids remain', () => {
    const result = buildExclusionClauses({
      excludedCategoryIds: [null, 0, 'oops', 2147483647],
      excludedRecipientIds: [-1, NaN],
    });
    expect(result.whereSql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('builds NOT IN predicate for categories using the same COALESCE chain', () => {
    const result = buildExclusionClauses({ excludedCategoryIds: [1, 2, 3] });
    expect(result.whereSql).toBe(
      'COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN ($1, $2, $3)',
    );
    expect(result.params).toEqual([1, 2, 3]);
    expect(result.nextParamIdx).toBe(4);
  });

  it('builds NOT IN predicate for recipients using primary-first COALESCE', () => {
    const result = buildExclusionClauses({ excludedRecipientIds: [7, 8] });
    expect(result.whereSql).toBe(
      'COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN ($1, $2)',
    );
    expect(result.params).toEqual([7, 8]);
    expect(result.nextParamIdx).toBe(3);
  });

  it('combines both exclusion lists with AND and sequential $-indices', () => {
    const result = buildExclusionClauses({
      excludedCategoryIds: [10, 11],
      excludedRecipientIds: [20],
      startParamIdx: 4,
    });
    expect(result.whereSql).toBe(
      'COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN ($4, $5)'
        + ' AND COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN ($6)',
    );
    expect(result.params).toEqual([10, 11, 20]);
    expect(result.nextParamIdx).toBe(7);
  });
});

describe('buildAggregationFilter', () => {
  it('merges base where with exclusions and shares the param counter', () => {
    const { joinSql, whereSql, params, nextParamIdx } = buildAggregationFilter({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      excludedCategoryIds: [10],
      excludedRecipientIds: [20, 21],
    });

    expect(joinSql).toContain('LEFT JOIN recipients r');
    expect(whereSql).toContain('t.is_active = true');
    expect(whereSql).toContain('t.date >= $1');
    expect(whereSql).toContain('t.date <= $2');
    expect(whereSql).toContain(
      'COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN ($3)',
    );
    expect(whereSql).toContain(
      'COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN ($4, $5)',
    );
    expect(params).toEqual(['2026-01-01', '2026-01-31', 10, 20, 21]);
    expect(nextParamIdx).toBe(6);
  });

  it('omits exclusion clauses when lists are empty, keeping base where intact', () => {
    const { whereSql, params, nextParamIdx } = buildAggregationFilter({
      bankAccount: 'BE12',
    });
    expect(whereSql).toBe('1=1 AND t.is_active = true AND t.bank_account ILIKE $1');
    expect(params).toEqual(['%BE12%']);
    expect(nextParamIdx).toBe(2);
  });
});
