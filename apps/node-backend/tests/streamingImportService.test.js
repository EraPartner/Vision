import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateReadStream } = vi.hoisted(() => ({
  mockCreateReadStream: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { createReadStream: mockCreateReadStream },
  createReadStream: mockCreateReadStream,
}));

vi.mock('../src/services/bankAdapters.js', () => ({
  createAdapter: vi.fn(),
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/textNormalization.js', () => ({
  normalizeForMatching: vi.fn((value) => String(value || '').toLowerCase().trim()),
}));

vi.mock('../src/repositories/rawTransactionRepository.js', () => ({
  computeHash: vi.fn(() => 'hash-123'),
  belfiusRawRepo: { create: vi.fn() },
  revolutRawRepo: { create: vi.fn() },
  kbcRawRepo: { create: vi.fn() },
  sabbRawRepo: { create: vi.fn() },
  wiseRawRepo: { create: vi.fn() },
  visionRawRepo: { create: vi.fn() },
  rawReferenceRepo: { create: vi.fn() },
  isRawDuplicate: vi.fn(),
}));

vi.mock('../src/services/deduplication.js', () => ({
  isDuplicateByFields: vi.fn(),
}));

import { createAdapter } from '../src/services/bankAdapters.js';
import { query } from '../src/database/connection.js';
import {
  belfiusRawRepo,
  kbcRawRepo,
  revolutRawRepo,
  sabbRawRepo,
  wiseRawRepo,
  visionRawRepo,
  rawReferenceRepo,
  isRawDuplicate,
} from '../src/repositories/rawTransactionRepository.js';
import { isDuplicateByFields } from '../src/services/deduplication.js';
import { importCSVStreaming } from '../src/services/streamingImportService.js';

function createLineCounterStream(chunks = ['line1\nline2\n']) {
  const handlers = {};
  const stream = {
    on: vi.fn((event, cb) => {
      handlers[event] = cb;
      return stream;
    }),
  };

  queueMicrotask(() => {
    for (const chunk of chunks) {
      if (handlers.data) handlers.data(chunk);
    }
    if (handlers.end) handlers.end();
  });

  return stream;
}

function makeTx(overrides = {}) {
  return {
    date: new Date('2026-01-15T00:00:00.000Z'),
    amount: -12.5,
    recipient: 'Coffee Shop',
    bankAccount: 'BE11',
    currency: 'EUR',
    balance: 50,
    memo: 'latte',
    comment: '',
    rawData: 'CARD_PAYMENT,Current,2026-01-15,2026-01-15,Coffee Shop,-12.5,0,EUR,COMPLETED,50',
    recipientAccount: 'BE22',
    recipientAddress: 'Main street',
    recipientBankName: 'Revolut',
    ...overrides,
  };
}

describe('streamingImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateReadStream.mockImplementation(() => createLineCounterStream());
    query.mockResolvedValue({ rows: [{ id: 100 }], rowCount: 1 });
    rawReferenceRepo.create.mockResolvedValue({ id: 900 });
    isRawDuplicate.mockResolvedValue(false);
    isDuplicateByFields.mockResolvedValue(false);
  });

  it('should import successfully and emit progress events with final aggregation', async () => {
    createAdapter.mockReturnValue(() => [makeTx(), makeTx({ rawData: 'x,y,z' })]);
    revolutRawRepo.create.mockResolvedValue({ id: 77 });

    const events = [];
    const result = await importCSVStreaming('/tmp/in.csv', 'revolut', null, (progress) => events.push(progress));

    expect(result).toEqual({ total_processed: 2, imported: 2, duplicates: 0, errors: 0 });
    expect(events.some(event => event.phase === 'counting')).toBe(true);
    expect(events.some(event => event.phase === 'importing')).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: 'complete', percent: 100, imported: 2 });
  });

  it('should aggregate duplicate and error outcomes from row processing', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({ rawData: 'row-1' }),
      makeTx({ rawData: 'row-2', memo: 'ok-row' }),
      makeTx({ rawData: 'row-3', memo: 'force-error' }),
    ]);

    revolutRawRepo.create
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 22 })
      .mockResolvedValueOnce({ id: 11 });

    query.mockImplementation(async (sql, params = []) => {
      if (sql.includes('INSERT INTO recipients')) {
        return { rows: [{ id: 1 }] };
      }
      if (sql.includes('INSERT INTO transactions')) {
        if (params[4] === 'force-error') {
          throw new Error('transaction insert failed');
        }
        return { rows: [{ id: 123 }] };
      }
      return { rows: [{ id: 1 }], rowCount: 1 };
    });

    const result = await importCSVStreaming('/tmp/in.csv', 'revolut');

    expect(result.total_processed).toBe(3);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.imported).toBe(1);
  });

  it('should use generic fallback dedup path and call isDuplicateByFields when raw dedup rejects', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ rawData: 'raw-generic' })]);
    isRawDuplicate.mockRejectedValue(new Error('unsupported bank type'));
    isDuplicateByFields.mockResolvedValue(true);

    const result = await importCSVStreaming('/tmp/in.csv', 'Some Unknown Bank');

    expect(result).toEqual({ total_processed: 1, imported: 0, duplicates: 1, errors: 0 });
    expect(isDuplicateByFields).toHaveBeenCalledWith('2026-01-15', -12.5, 'Coffee Shop', 'latte');
  });

  it('should return failed status and emit error progress when parser throws', async () => {
    createAdapter.mockImplementation(() => {
      throw new Error('adapter exploded');
    });

    const events = [];
    const result = await importCSVStreaming('/tmp/in.csv', 'revolut', null, (progress) => events.push(progress));

    expect(result.status).toBe('failed');
    expect(result.error_message).toBe('adapter exploded');
    expect(events.at(-1)).toMatchObject({ phase: 'error', status: 'failed' });
  });

  it('should map revolut raw fields and attempt raw reference link', async () => {
    const rawLine = 'CARD_PAYMENT,Current,15/01/2026 10:00:00,15/01/2026 10:01:00,Morning coffee,-12,0,EUR,COMPLETED,1234.56';
    createAdapter.mockReturnValue(() => [makeTx({ rawData: rawLine, amount: -12, balance: 1234.56 })]);
    revolutRawRepo.create.mockResolvedValue({ id: 444 });

    await importCSVStreaming('/tmp/in.csv', 'Revolut Personal');

    expect(revolutRawRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      transaction_type: 'CARD_PAYMENT',
      product: 'Current',
      description: 'Morning coffee',
      amount: -12,
      currency: 'EUR',
      state: 'COMPLETED',
      raw_csv_line: rawLine,
    }));

    expect(rawReferenceRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      rawSourceType: 'revolut',
      rawSourceId: 444,
      transactionId: expect.any(Number),
    }));
  });

  it('should cover non-revolut bank type routing and raw repo storage', async () => {
    const cases = [
      {
        bankName: 'Belfius',
        repo: belfiusRawRepo,
        rawData: 'BE11;15/01/2026;STMT;TRX;BE22;"He said ""hi""";Street;City;Desc;15/01/2026;(1.234,56);EUR;BIC;BE;Msg',
      },
      {
        bankName: 'KBC',
        repo: kbcRawRepo,
        rawData: 'BE11;Category;Holder;EUR;STMT;15/01/2026;Description;15/01/2026;1.234,56;100,00;10,00;0,00;BE22;BIC;Recipient;Address;SC;FC',
      },
      {
        bankName: 'SABB',
        repo: sabbRawRepo,
        rawData: 'X|15/01/2026|Description|X|10.50|POSTED',
      },
      {
        bankName: 'Wise',
        repo: wiseRawRepo,
        rawData: 'id|completed|outgoing|x|15/01/2026 10:00:00|src|12,34|0,56|EUR|EUR|dst|50,00|USD|3,75|ref|batch',
      },
      {
        bankName: 'Vision',
        repo: visionRawRepo,
        rawData: 'x|x|BE11|Recipient|Memo|EUR|x|CATEGORY|Comment',
      },
    ];

    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO recipients')) return { rows: [{ id: 1 }] };
      if (sql.includes('INSERT INTO transactions')) return { rows: [{ id: 2 }] };
      return { rows: [{ id: 1 }], rowCount: 1 };
    });

    for (const testCase of cases) {
      testCase.repo.create.mockResolvedValueOnce({ id: 777 });
      createAdapter.mockReturnValueOnce(() => [makeTx({ rawData: testCase.rawData })]);

      const result = await importCSVStreaming('/tmp/in.csv', testCase.bankName);
      expect(result).toEqual({ total_processed: 1, imported: 1, duplicates: 0, errors: 0 });
      expect(testCase.repo.create).toHaveBeenCalled();
    }
  });

  it('should return an error row outcome when existing recipient lookup fails after conflict', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ recipient: '' })]);
    revolutRawRepo.create.mockResolvedValue({ id: 444 });

    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO recipients')) return { rows: [] };
      if (sql.includes('SELECT id FROM recipients')) return { rows: [] };
      return { rows: [] };
    });

    const result = await importCSVStreaming('/tmp/in.csv', 'revolut');
    expect(result).toEqual({ total_processed: 1, imported: 0, duplicates: 0, errors: 1 });
  });

  it('should mark the row as error when raw reference creation fails', async () => {
    // Regression: rawReferenceRepo.create() used to be fire-and-forget, so
    // a failed audit link silently produced an orphan transaction with no
    // raw_reference. The error has to surface to the import counters.
    createAdapter.mockReturnValue(() => [makeTx({ rawData: 'orphan-row' })]);
    revolutRawRepo.create.mockResolvedValue({ id: 555 });
    rawReferenceRepo.create.mockRejectedValueOnce(new Error('reference table locked'));

    const result = await importCSVStreaming('/tmp/in.csv', 'revolut');

    expect(result.total_processed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('should fail early when line counting stream emits an error', async () => {
    mockCreateReadStream.mockImplementationOnce(() => {
      const handlers = {};
      const stream = {
        on: vi.fn((event, cb) => {
          handlers[event] = cb;
          return stream;
        }),
      };

      queueMicrotask(() => {
        if (handlers.error) handlers.error(new Error('read failure'));
      });

      return stream;
    });

    const events = [];
    const result = await importCSVStreaming('/tmp/in.csv', 'revolut', null, (progress) => events.push(progress));

    expect(result.status).toBe('failed');
    expect(result.error_message).toBe('read failure');
    expect(events.at(-1)).toMatchObject({ phase: 'error', status: 'failed' });
  });
});
