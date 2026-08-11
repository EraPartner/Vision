/**
 * Contract pins for the transactions list/export *id* query params —
 * `transaction_id`, `category_id`, `recipient_id`, `recipient_group_id`
 * (scalars) and `category_ids` / `account_ids` (comma-separated lists).
 *
 * These sat UPSTREAM of `validateInt4Ids`, so the SQL-build convergence did not
 * close them: by the time the builder saw the value it was already a clean
 * integer. Both failure modes were live and neither surfaced.
 *
 *   retarget — `?category_id=12abc` filtered by category 12, `?recipient_group_id=1e3`
 *              by group 1, `?category_ids=5,12abc` by categories 5 AND 12, and
 *              `?account_ids=12abc` exported account 12: a record nobody named.
 *   widen    — `?account_ids=abc` parsed to an empty list, which the caller
 *              mapped back to "no filter", so `GET /export/csv` streamed EVERY
 *              account's transactions into a file the user keeps, 200 and all.
 *
 * The export half is the one that matters most: a silently widened export is a
 * correctness failure the user may never notice, because the file looks fine.
 *
 * Absent and empty are deliberately NOT part of that. "Param not sent" and
 * "param sent empty" both still mean *no filter* and answer 200 — the unset
 * convention `assertOptionalId` and `parseIdArrayQueryParam` use, and what every
 * shipped caller emits for an empty filter. Pinned here so a later tightening
 * cannot take it away by accident.
 *
 * Runs against the REAL router on a throwaway Express app (helpers/routeApp.js),
 * so the parse, the error handler and the ADR-026 envelope are all real; only
 * the repository / db client are mocked. Every rejection case additionally
 * asserts that the repository (or the db client, for the streamed exports) was
 * never reached, which is the difference between "answered differently" and
 * "answered with an unrequested row set".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import {
  mockTransactionRepository,
  mockDeduplication,
  mockMaterializedViews,
  mockCurrencyConversion,
  mockAttachmentRecordService,
  mockAttachmentService,
} from '../helpers/transactionsRouteMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());
vi.mock('../../src/config/logger.js', () => ({ logger: mockLogger() }));
vi.mock('../../src/services/deduplication.js', () => mockDeduplication());
vi.mock('../../src/services/materializedViewService.js', () => mockMaterializedViews());
vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());
vi.mock('../../src/database/connection.js', () => mockConnection());
vi.mock('../../src/services/attachmentRecordService.js', () => mockAttachmentRecordService());
vi.mock('../../src/services/attachmentService.js', () => mockAttachmentService());
vi.mock('../../src/services/transferReconciliationService.js', () => ({
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(async () => []),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import { markTransfer } from '../../src/services/transferReconciliationService.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { convertRowsToEur } from '../../src/services/currency/currencyConversionService.js';
import { attachmentRepository } from '../../src/services/attachmentRecordService.js';

const { default: transactionsRouter } = await import('../../src/routes/transactions.js');

const api = routeAgent(transactionsRouter, { mountPath: '/api/transactions' });

const list = (query = '') => api.get(`/api/transactions/${query ? `?${query}` : ''}`);
const exportCsv = (query = '') => api.get(`/api/transactions/export/csv${query ? `?${query}` : ''}`);

/** Filter options the list handler passed to the repository. */
const listOpts = () => transactionRepository.getAllWithCount.mock.calls[0][0];
/** WHERE SQL + params of the export's first (probe) query. */
const exportQuery = () => dbQuery.mock.calls[0];

/** The export streams: a row-probe query, then the chunked page query. */
const armExport = () => {
  dbQuery.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
  convertRowsToEur.mockImplementation(async (rows) => rows);
  attachmentRepository.listPathsByTransactionIds.mockResolvedValue([]);
  transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });
});

/**
 * The accept set is `validateId`'s, not a second rule: a plain base-10 digit
 * string (leading zeros allowed) or an integer number, 1..2^31-1.
 */
const ACCEPTED = [['5', 5], ['007', 7], ['2147483647', 2147483647]];

const REJECTED = [
  '12abc',      // trailing garbage — the headline case, resolved to id 12
  '5px',
  '12.5',       // decimals — parseInt truncated to 12
  '1e3',        // exponent — parseInt gave 1
  '0x10',       // hex / octal / binary literals
  '0o17',
  '+5',         // signs and separators
  '-4',
  '1_0',
  ' 5 ',        // whitespace-padded
  'NaN',        // what the Transactions page sends for a hand-edited URL
  'Infinity',
  '0',          // out of range — no row has id 0
  '2147483648',
  '٥',          // non-ASCII digits
];

/** Scalar id filters on the list endpoint → the repository option they set. */
const SCALAR_PARAMS = [
  ['transaction_id', 'transactionId'],
  ['category_id', 'categoryId'],
  ['recipient_id', 'recipientId'],
  ['recipient_group_id', 'recipientGroupId'],
  // Already strict before this change (it was the one param on the list that
  // used assertOptionalId); pinned alongside the others so the four that just
  // joined it cannot drift back out.
  ['account_id', 'accountId'],
];

describe('GET /api/transactions — scalar id query params reject instead of truncating', () => {
  for (const [param, option] of SCALAR_PARAMS) {
    for (const raw of REJECTED) {
      it(`400s on ${param}=${raw} without reaching the repository`, async () => {
        const res = await list(`${param}=${encodeURIComponent(raw)}`).expect(400);
        expect(res.body).toEqual(errEnvelope({
          code: 'VALIDATION_ERROR',
          message: `${param} must be a positive integer`,
        }));
        expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
      });
    }

    for (const [raw, parsed] of ACCEPTED) {
      it(`accepts ${param}=${raw} and passes ${parsed} to the repository`, async () => {
        await list(`${param}=${encodeURIComponent(raw)}`).expect(200);
        expect(listOpts()[option]).toBe(parsed);
      });
    }

    it(`treats an absent ${param} as "no filter" (200, null)`, async () => {
      await list().expect(200);
      expect(listOpts()[option]).toBeNull();
    });

    it(`treats an empty ${param}= as "no filter", not as an error`, async () => {
      await list(`${param}=`).expect(200);
      expect(listOpts()[option]).toBeNull();
    });
  }

  // parseInt("1,2") was 1, so a repeated scalar silently filtered by the first
  // value. An id param is single-valued; two of them is a malformed request.
  it('rejects a repeated scalar param rather than taking the first value', async () => {
    await list('recipient_id=1&recipient_id=2').expect(400);
    expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
  });
});

describe('GET /api/transactions — category_ids rejects instead of retargeting or vanishing', () => {
  it('parses a comma-separated list in order', async () => {
    await list('category_ids=5,007,2147483647').expect(200);
    expect(listOpts().categoryIds).toEqual([5, 7, 2147483647]);
  });

  it('parses repeated occurrences as one list too', async () => {
    await list('category_ids=5&category_ids=9').expect(200);
    expect(listOpts().categoryIds).toEqual([5, 9]);
  });

  for (const raw of REJECTED) {
    it(`400s on category_ids=${raw}`, async () => {
      const res = await list(`category_ids=${encodeURIComponent(raw)}`).expect(400);
      expect(res.body).toEqual(errEnvelope({
        code: 'VALIDATION_ERROR',
        message: `category_ids contains invalid value: ${raw}`,
      }));
      expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
    });
  }

  // The retarget half: the bad element used to become category 12 and join the
  // IN list, so the answer covered a category the caller never named.
  it('rejects the whole list when one element is bad — no partial filter set', async () => {
    const res = await list('category_ids=5,12abc,9').expect(400);
    expect(res.body.error.message).toBe('category_ids contains invalid value: 12abc');
    expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
  });

  // The widen half: an all-bad list parsed to [], which the caller mapped back
  // to "no filter" and answered with the unfiltered dataset.
  it('rejects an all-bad list rather than answering with no category filter', async () => {
    await list('category_ids=abc,def').expect(400);
    expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
  });

  it('rejects an empty element inside a list (distinct from an empty param)', async () => {
    await list('category_ids=5,').expect(400);
    expect(transactionRepository.getAllWithCount).not.toHaveBeenCalled();
  });

  it('treats absent and empty category_ids as "no filter" (200, null)', async () => {
    // Every encoding of "sent but empty" lands on the unset convention, not on
    // the empty-element rejection: `?ids=` is 200, `?ids=5,` is 400.
    for (const query of ['', 'category_ids=', 'category_ids[]=']) {
      vi.clearAllMocks();
      transactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });
      await list(query).expect(200);
      expect(listOpts().categoryIds).toBeNull();
    }
  });

  // A well-formed id whose category no longer exists is not malformed: it
  // passes validation and simply matches nothing, so a stale saved filter or a
  // shared pivot-drill link still answers 200 rather than 400.
  it('accepts a well-formed id for a category that no longer exists', async () => {
    await list('category_ids=2147483646').expect(200);
    expect(listOpts().categoryIds).toEqual([2147483646]);
  });
});

describe('GET /api/transactions/export/* — account_ids no longer widens the export', () => {
  it('builds the account IN clause from a comma-separated list', async () => {
    armExport();
    await exportCsv('account_ids=3,9').expect(200);
    const [sql, params] = exportQuery();
    expect(sql).toMatch(/t\.account_id IN \(\$\d+, \$\d+\)/);
    expect(params).toEqual([3, 9]);
  });

  // The failure this test exists for: `account_ids=abc` emitted NO account
  // predicate at all, so the CSV the user downloaded and kept contained every
  // account's transactions, with a 200 and a plausible-looking file.
  it('400s on an all-bad account_ids instead of exporting every account', async () => {
    const res = await exportCsv('account_ids=abc').expect(400);
    expect(res.body).toEqual(errEnvelope({
      code: 'VALIDATION_ERROR',
      message: 'account_ids contains invalid value: abc',
    }));
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('400s on a partly-bad account_ids instead of exporting the wrong accounts', async () => {
    const res = await exportCsv('account_ids=3,12abc,9').expect(400);
    expect(res.body.error.message).toBe('account_ids contains invalid value: 12abc');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  for (const raw of REJECTED) {
    it(`400s the CSV export on account_ids=${raw}`, async () => {
      await exportCsv(`account_ids=${encodeURIComponent(raw)}`).expect(400);
      expect(dbQuery).not.toHaveBeenCalled();
    });
  }

  it('400s the NDJSON export on the same input (both exports share buildExportFilters)', async () => {
    const res = await api.get('/api/transactions/export/json?account_ids=12abc').expect(400);
    expect(res.body.error.message).toBe('account_ids contains invalid value: 12abc');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('treats absent and empty account_ids as "no account filter" (200, no IN clause)', async () => {
    armExport();
    await exportCsv().expect(200);
    expect(exportQuery()[0]).not.toMatch(/t\.account_id IN/);

    vi.clearAllMocks();
    armExport();
    await exportCsv('account_ids=').expect(200);
    expect(exportQuery()[0]).not.toMatch(/t\.account_id IN/);
  });

  // Validation runs over the whole list before EXPORT_MAX_LIST_SIZE (50) caps
  // it, so a malformed id past the cap still rejects rather than being sliced
  // away unseen. The cap's own silent truncation is unchanged.
  it('validates elements beyond the export cap, then still caps the accepted list', async () => {
    const overCap = Array.from({ length: 60 }, (_, i) => i + 1);
    await exportCsv(`account_ids=${[...overCap, '12abc'].join(',')}`).expect(400);
    expect(dbQuery).not.toHaveBeenCalled();

    vi.clearAllMocks();
    armExport();
    await exportCsv(`account_ids=${overCap.join(',')}`).expect(200);
    expect(exportQuery()[1]).toHaveLength(50);
  });

  it('applies the same strict parse to the export path\'s scalar and category filters', async () => {
    for (const query of ['transaction_id=12abc', 'category_id=1e3', 'recipient_id=12.5', 'recipient_group_id=0', 'category_ids=5,12abc']) {
      vi.clearAllMocks();
      await exportCsv(query).expect(400);
      expect(dbQuery).not.toHaveBeenCalled();
    }
  });
});

describe('POST /api/transactions/transfers — body ids reject instead of truncating', () => {
  it('marks a transfer for two well-formed ids', async () => {
    await api.post('/api/transactions/transfers').send({ aId: 4, bId: '9' }).expect(200);
    expect(markTransfer).toHaveBeenCalledWith(4, 9);
  });

  // Not a wrong-record *read* like the query params above — a wrong-record
  // WRITE: "12abc" stamped transaction 12 as one leg of a transfer pair.
  it('400s on a trailing-garbage id instead of marking a transaction nobody named', async () => {
    const res = await api.post('/api/transactions/transfers').send({ aId: '12abc', bId: 7 }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(markTransfer).not.toHaveBeenCalled();
  });

  it('400s on ids outside int4 rather than 500ing at the column', async () => {
    await api.post('/api/transactions/transfers').send({ aId: 99999999999, bId: 7 }).expect(400);
    expect(markTransfer).not.toHaveBeenCalled();
  });

  it('still rejects a missing id, a non-positive id and two identical ids', async () => {
    for (const body of [{ bId: 7 }, { aId: 0, bId: 7 }, { aId: -1, bId: 7 }, { aId: 5, bId: 5 }]) {
      vi.clearAllMocks();
      await api.post('/api/transactions/transfers').send(body).expect(400);
      expect(markTransfer).not.toHaveBeenCalled();
    }
  });
});
