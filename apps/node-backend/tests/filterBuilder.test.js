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

  it('recipientGroupId resolves full primary group including parent and siblings', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ recipientGroupId: 7 });
    expect(sql).toContain('t.recipient_id = $1');
    expect(sql).toContain('r.primary_recipient_id = $1');
    expect(sql).toContain('SELECT primary_recipient_id FROM recipients WHERE id = $1 AND primary_recipient_id IS NOT NULL');
    expect(params).toEqual([7]);
    expect(nextParamIdx).toBe(2);
  });

  it('recipientGroupId and recipientId can coexist and use sequential $-indices', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ recipientId: 3, recipientGroupId: 7 });
    expect(sql).toContain('t.recipient_id = $1 OR r.primary_recipient_id = $1');
    expect(sql).toContain('t.recipient_id = $2');
    expect(params).toEqual([3, 7]);
    expect(nextParamIdx).toBe(3);
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

describe('buildTransactionWhere — bankAccounts (plural IN clause)', () => {
  it('builds correct IN clause for exact IBAN match', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ bankAccounts: ['NL12INGB0001234567', 'BE68539007547034'], active: false });
    expect(sql).toContain('t.bank_account IN ($1, $2)');
    expect(params).toEqual(['NL12INGB0001234567', 'BE68539007547034']);
    expect(nextParamIdx).toBe(3);
  });

  it('skips clause when array is empty', () => {
    const { sql, params } = buildTransactionWhere({ bankAccounts: [], active: false });
    expect(sql).not.toContain('t.bank_account IN');
    expect(params).toHaveLength(0);
  });

  it('filters out empty string values', () => {
    const { sql, params } = buildTransactionWhere({ bankAccounts: ['', '  '], active: false });
    expect(sql).not.toContain('t.bank_account IN');
    expect(params).toHaveLength(0);
  });

  it('bankAccount (singular ILIKE) takes precedence over bankAccounts', () => {
    const { sql, params } = buildTransactionWhere({ bankAccount: 'NL12', bankAccounts: ['BE68539007547034'], active: false });
    expect(sql).toContain('ILIKE');
    expect(sql).not.toContain('IN (');
    expect(params).toEqual(['%NL12%']);
  });

  it('caps at MAX_LIST_SIZE (50) entries', () => {
    const accounts = Array.from({ length: 60 }, (_, i) => `IBAN${i}`);
    const { params } = buildTransactionWhere({ bankAccounts: accounts, active: false });
    expect(params).toHaveLength(50);
  });

  it('respects startParamIdx offset', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ bankAccounts: ['NL12INGB0001234567'], active: false, startParamIdx: 4 });
    expect(sql).toContain('IN ($4)');
    expect(params).toEqual(['NL12INGB0001234567']);
    expect(nextParamIdx).toBe(5);
  });
});

describe('buildTransactionWhere — transactionType', () => {
  it('adds t.amount > 0 for income', () => {
    const { sql } = buildTransactionWhere({ transactionType: 'income', active: false });
    expect(sql).toContain('t.amount > 0');
    expect(sql).not.toContain('t.amount < 0');
  });

  it('adds t.amount < 0 for expense', () => {
    const { sql } = buildTransactionWhere({ transactionType: 'expense', active: false });
    expect(sql).toContain('t.amount < 0');
    expect(sql).not.toContain('t.amount > 0');
  });

  it('adds no amount clause for null transactionType', () => {
    const { sql } = buildTransactionWhere({ transactionType: null, active: false });
    expect(sql).not.toContain('t.amount');
  });

  it('transactionType does not consume $-params', () => {
    const { params, nextParamIdx } = buildTransactionWhere({ transactionType: 'income', active: false });
    expect(params).toHaveLength(0);
    expect(nextParamIdx).toBe(1);
  });
});

describe('buildTransactionWhere — categoryIds (plural IN clause)', () => {
  it('builds correct IN clause', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ categoryIds: [2, 5, 9], active: false });
    expect(sql).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IN ($1, $2, $3)');
    expect(params).toEqual([2, 5, 9]);
    expect(nextParamIdx).toBe(4);
  });

  it('drops invalid ids silently and skips clause when nothing remains', () => {
    const { sql, params } = buildTransactionWhere({ categoryIds: [0, -1, null, 1.5], active: false });
    expect(sql).not.toContain('IN (');
    expect(params).toHaveLength(0);
  });

  it('categoryId (singular) takes precedence over categoryIds', () => {
    const { sql, params } = buildTransactionWhere({ categoryId: 3, categoryIds: [1, 2], active: false });
    expect(sql).toContain('= $1');
    expect(sql).not.toContain('IN (');
    expect(params).toEqual([3]);
  });

  it('respects startParamIdx offset', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ categoryIds: [4, 7], active: false, startParamIdx: 3 });
    expect(sql).toContain('IN ($3, $4)');
    expect(params).toEqual([4, 7]);
    expect(nextParamIdx).toBe(5);
  });
});

describe('buildTransactionWhere — tagSlugs', () => {
  it('emits EXISTS subquery for a single tag slug', () => {
    const { sql, params } = buildTransactionWhere({ tagSlugs: ['rome-2020'], active: false });
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('transaction_tags');
    expect(sql).toContain('ANY($1::text[])');
    expect(params).toEqual([['rome-2020']]);
  });

  it('passes multiple slugs as a single array param (OR semantics)', () => {
    const { sql, params } = buildTransactionWhere({ tagSlugs: ['rome-2020', 'lisbon-2024'], active: false });
    expect(sql).toContain('ANY($1::text[])');
    expect(params).toHaveLength(1);
    expect(params[0]).toEqual(['rome-2020', 'lisbon-2024']);
  });

  it('filters only active tags (is_active = true)', () => {
    const { sql } = buildTransactionWhere({ tagSlugs: ['rome-2020'], active: false });
    expect(sql).toContain('is_active = true');
  });

  it('joins on tag_id so inactive tags are excluded from match', () => {
    const { sql } = buildTransactionWhere({ tagSlugs: ['rome-2020'], active: false });
    expect(sql).toContain('tg.id = tt.tag_id');
  });

  it('produces no clause when tagSlugs is empty', () => {
    const { sql, params } = buildTransactionWhere({ tagSlugs: [], active: false });
    expect(sql).not.toContain('transaction_tags');
    expect(params).toHaveLength(0);
  });

  it('produces no clause when tagSlugs is null', () => {
    const { sql } = buildTransactionWhere({ tagSlugs: null, active: false });
    expect(sql).not.toContain('transaction_tags');
  });

  it('strips blank/whitespace-only slug entries', () => {
    const { sql, params } = buildTransactionWhere({ tagSlugs: ['rome-2020', '  ', ''], active: false });
    expect(params[0]).toEqual(['rome-2020']);
  });

  it('produces no clause when all slugs are blank after trim', () => {
    const { sql, params } = buildTransactionWhere({ tagSlugs: ['  ', ''], active: false });
    expect(sql).not.toContain('EXISTS');
    expect(params).toHaveLength(0);
  });

  it('caps at MAX_LIST_SIZE (50) entries', () => {
    const manySlugs = Array.from({ length: 60 }, (_, i) => `tag-${i}`);
    const { params } = buildTransactionWhere({ tagSlugs: manySlugs, active: false });
    expect(params[0]).toHaveLength(50);
  });

  it('respects startParamIdx offset', () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({ tagSlugs: ['rome-2020'], active: false, startParamIdx: 5 });
    expect(sql).toContain('ANY($5::text[])');
    expect(params).toEqual([['rome-2020']]);
    expect(nextParamIdx).toBe(6);
  });
});
