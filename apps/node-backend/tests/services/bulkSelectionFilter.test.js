/**
 * normalizeBulkFilter — the accept/reject contract of the `filter` selector
 * shared by POST /bulk-delete, /bulk-update and /bulk-export.
 *
 * Why this file exists, and why it is this thorough. The `ids` path of
 * resolveBulkSelection was made strict in 00f8281d; the sibling `filter` path
 * was not, and it carried the same class of defect in a form that is invisible
 * by construction. Every filter field was applied on a best-effort basis: a
 * field that failed its type guard was SKIPPED, not rejected. On a read that
 * only over-returns. On POST /bulk-delete it means the delete ran against a
 * WIDER set than the caller named — `{category_ids: '5'}` (a string where the
 * array was expected) emitted no category clause at all and deleted every
 * transaction the rest of the filter matched, answering 200 with a plausible
 * count. Reproduced end-to-end against a real Postgres before this change:
 * a 4-row corpus, a filter naming 2 of them, `{"deleted": 4}`.
 *
 * The same shape was live on five more fields and on unknown keys, so the
 * tests below enumerate the whole surface field by field rather than pinning
 * the one case the finding named.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockConnection } from '../helpers/repoMocks.js';
vi.mock('../../src/database/connection.js', () => mockConnection({ getClient: vi.fn() }));

const { resolveBulkSelection, normalizeBulkFilter } =
  await import('../../src/services/bulkSelection.js');
const { query: dbQuery } = await import('../../src/database/connection.js');
const { ValidationError } = await import('../../src/middleware/errorHandler.js');

/** Every filter that must be rejected, grouped by the field it exercises. */
const REJECTED = {
  // Passed straight into `$n` before this change: Postgres answered 22P02 and
  // the request became a 500. Confirmed against a real database.
  transaction_id: ['12abc', 'abc', '1e3', '0x10', 0, -4, 1.5, true, [7], {}, '2147483648'],
  account_id: ['12abc', 'abc', 0, true],
  category_id: ['12abc', 'abc', 0, true],
  recipient_id: ['12abc', 'abc', 0, true],
  recipient_group_id: ['12abc', 'abc', 0, true],
  // Same 22P02 → 500 story, on a date column ('banana' → invalid input syntax
  // for type date). The list endpoint has used assertYmd here for a long time.
  start_date: ['banana', '2026-13-01', '01-01-2026', 20260101, true, {}],
  // Not pinned here: '2026-02-30' passes assertYmd (`new Date` rolls it over to
  // March 2) and 500s at the column. That is assertYmd's own pre-existing gap,
  // shared with the list endpoint and every other route using it — not a widen.
  end_date: ['banana', '2026-13-01', true],
  // The widen the finding named. A scalar is NOT wrapped into a one-element
  // array here (that is what `category_id` is for) — it is rejected, because a
  // caller who sent the wrong shape has no idea which rows they are about to act on.
  category_ids: ['5', '5,6', 5, {}, [5, '12abc'], [0], [null], [[5]], ['1e3']],
  // Identical Array.isArray guard in the builder, identical widen.
  bank_accounts: ['KBC', 'KBC,ING', 7, {}, [''], ['  '], [7], [null]],
  tags: [7, {}, true, 'rome-2020,', ',', ['rome-2020', ''], [7]],
  // Value guard rather than a type guard, same outcome: 'Expense' is not
  // 'expense', so the clause vanished and the delete covered income too.
  transaction_type: ['Expense', 'EXPENSE', 'transfer', 7, true, {}],
  // parseAmountFilter returns null for anything unparseable, so the bound was
  // silently dropped and the delete ran unbounded.
  amount_min: ['25abc', 'abc', 'Infinity', Infinity, NaN, true, {}, []],
  amount_max: ['25abc', NaN, true],
  // Collapsed to the default instead of being rejected: `active: 0` was read
  // as `active: true`.
  active: [0, 1, 'yes', 'TRUE', {}],
  amount_signed: [0, 1, 'yes', {}],
  // Non-strings reached the ILIKE as '[object Object]' / 'a,b'.
  search: [7, {}, ['a'], true],
  bank_account: [7, {}, true],
  recipient_name: [7, {}, true],
};

/**
 * Absent, JSON `null` and empty all mean "no filter on this field" and stay
 * 200 — the unset convention assertOptionalId and the list endpoint's query
 * params use. `null` matters concretely: the Transactions page computes its id
 * filters with `Number(param)`, and a `NaN` serialises to `null` over JSON.
 */
const UNSET_FORMS = {
  transaction_id: [undefined, null, ''],
  account_id: [undefined, null, ''],
  category_id: [undefined, null, ''],
  recipient_id: [undefined, null, ''],
  recipient_group_id: [undefined, null, ''],
  start_date: [undefined, null, ''],
  end_date: [undefined, null, ''],
  category_ids: [undefined, null, []],
  bank_accounts: [undefined, null, []],
  tags: [undefined, null, '', []],
  transaction_type: [undefined, null, ''],
  amount_min: [undefined, null, ''],
  amount_max: [undefined, null, ''],
  search: [undefined, null, ''],
  bank_account: [undefined, null, ''],
  recipient_name: [undefined, null, ''],
};

describe('normalizeBulkFilter — rejects instead of silently ignoring', () => {
  for (const [field, values] of Object.entries(REJECTED)) {
    it(`rejects every malformed \`${field}\``, () => {
      for (const value of values) {
        expect(
          () => normalizeBulkFilter({ [field]: value }),
          `expected ${field}=${JSON.stringify(value)} to be rejected`,
        ).toThrow(ValidationError);
      }
    });
  }

  it('rejects a key it does not recognise rather than answering "no filter"', () => {
    // The worst of the set: nothing in the body was understood, so the filter
    // resolved to "every active transaction" and bulk-delete swept the table
    // up to the 5000-row cap. `account_ids` is a real list-endpoint param this
    // normaliser never supported, and `catgeory_id` is a plain typo.
    for (const filter of [
      { account_ids: [7] },
      { amount_exact: 12 },
      { catgeory_id: 7 },
      { limit: 10 },
      { search: 'cafe', unknown_thing: 1 },
    ]) {
      expect(() => normalizeBulkFilter(filter)).toThrow(/unknown field/i);
    }
  });

  it('rejects an array body, which reached the builder as an empty filter', () => {
    expect(() => normalizeBulkFilter([1, 2])).toThrow(ValidationError);
  });

  it('rejects one field spelled both ways rather than silently preferring one', () => {
    expect(() => normalizeBulkFilter({ categoryId: 7, category_id: 9 })).toThrow(/not both/i);
    expect(() => normalizeBulkFilter({ tagSlugs: ['a'], tags: ['b'] })).toThrow(/not both/i);
  });

  it('rejects an over-long search instead of truncating it', () => {
    // The list endpoint slices `search` to 200 chars. Truncating a substring
    // match makes it match MORE rows, so on a delete this rejects instead.
    expect(() => normalizeBulkFilter({ search: 'x'.repeat(201) })).toThrow(ValidationError);
    expect(normalizeBulkFilter({ search: 'x'.repeat(200) }).search).toHaveLength(200);
  });
});

describe('normalizeBulkFilter — accepts what real callers send', () => {
  it('accepts the full snake_case body the Transactions page builds', () => {
    // Field-for-field the frontend's BulkTransactionFilter (types/api.ts), as
    // TransactionsPage.currentFilter fills it in.
    const out = normalizeBulkFilter({
      transaction_id: 5,
      recipient_id: 99,
      category_id: 7,
      category_ids: [1, 2, 3],
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      transaction_type: 'expense',
      amount_min: 10,
      amount_max: 250.5,
      amount_signed: true,
      tags: ['rome-2020', 'work'],
      account_id: 4,
      bank_account: 'KBC',
      bank_accounts: ['KBC CURRENT', 'ING'],
      recipient_group_id: 12,
      recipient_name: 'Delhaize',
      search: 'cafe',
      active: true,
    });
    expect(out).toEqual({
      transactionId: 5,
      recipientId: 99,
      categoryId: 7,
      categoryIds: [1, 2, 3],
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      transactionType: 'expense',
      amountMin: 10,
      amountMax: 250.5,
      amountSigned: true,
      tagSlugs: ['rome-2020', 'work'],
      accountId: 4,
      bankAccount: 'KBC',
      bankAccounts: ['KBC CURRENT', 'ING'],
      recipientGroupId: 12,
      recipientName: 'Delhaize',
      search: 'cafe',
      active: true,
    });
  });

  it('keeps the query-string spellings the module documents', () => {
    const out = normalizeBulkFilter({
      active: 'false',
      amount_signed: 'true',
      amount_min: '10',
      tags: 'rome-2020, WORK',
      transaction_id: '5',
    });
    expect(out.active).toBe(false);
    expect(out.amountSigned).toBe(true);
    expect(out.amountMin).toBe(10);
    expect(out.tagSlugs).toEqual(['rome-2020', 'work']);
    expect(out.transactionId).toBe(5);
  });

  it('accepts camelCase keys', () => {
    const out = normalizeBulkFilter({ startDate: '2026-01-01', tagSlugs: ['rome-2020'] });
    expect(out.startDate).toBe('2026-01-01');
    expect(out.tagSlugs).toEqual(['rome-2020']);
  });

  it('treats absent, null and empty as "no filter on this field"', () => {
    for (const [field, values] of Object.entries(UNSET_FORMS)) {
      for (const value of values) {
        const out = normalizeBulkFilter({ [field]: value });
        expect(
          Object.values(out).filter((v) => v !== null && v !== true && v !== false),
          `expected ${field}=${JSON.stringify(value)} to apply no predicate`,
        ).toEqual([]);
      }
    }
  });

  it('still resolves the whole-table selection the "select all N matching" flow sends', async () => {
    // With no filters set, the Transactions page posts `{active: true}` and
    // nothing else (JSON drops the undefined keys). That is a legitimate
    // request — the 5000-row cap, not this validator, is what bounds it — so
    // it must not be mistaken for an empty/ignored filter and rejected.
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 12 }] });
    expect(await resolveBulkSelection({ filter: { active: true } })).toEqual([11, 12]);
  });

  it('keeps amount magnitude vs signed semantics', () => {
    expect(normalizeBulkFilter({ amount_min: -50 }).amountMin).toBe(50);
    expect(normalizeBulkFilter({ amount_min: -50, amount_signed: true }).amountMin).toBe(-50);
  });

  it('returns empty object on null input', () => {
    expect(normalizeBulkFilter(null)).toEqual({});
    expect(normalizeBulkFilter(undefined)).toEqual({});
  });
});

describe('resolveBulkSelection — a malformed filter never reaches the database', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects before the COUNT(*) precheck, so nothing is counted or selected', async () => {
    for (const filter of [
      { category_ids: '5' },
      { bank_accounts: 'KBC' },
      { transaction_type: 'Expense' },
      { amount_min: '25abc' },
      { recipient_id: '12abc' },
      { start_date: 'banana' },
      { account_ids: [7] },
    ]) {
      await expect(
        resolveBulkSelection({ filter }),
        `expected ${JSON.stringify(filter)} to be rejected`,
      ).rejects.toThrow(ValidationError);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
