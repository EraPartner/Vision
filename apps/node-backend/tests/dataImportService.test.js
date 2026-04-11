import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn() },
  readFileSync: vi.fn(),
}));

vi.mock('csv-parse/sync', () => ({
  parse: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/repositories/recipientRepository.js', () => ({
  recipientRepository: {
    createOrGet: vi.fn(),
  },
}));

vi.mock('../src/repositories/categoryRepository.js', () => ({
  categoryRepository: {
    createOrGet: vi.fn(),
  },
}));

vi.mock('../src/repositories/recipientBankAccountRepository.js', () => ({
  recipientBankAccountRepository: {
    createOrGet: vi.fn(),
  },
}));

import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { logger } from '../src/config/logger.js';
import { query } from '../src/database/connection.js';
import { recipientRepository } from '../src/repositories/recipientRepository.js';
import { categoryRepository } from '../src/repositories/categoryRepository.js';
import { recipientBankAccountRepository } from '../src/repositories/recipientBankAccountRepository.js';
import { importRecipientsCSV, importCategoriesCSV } from '../src/services/dataImportService.js';

describe('Data Import Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.readFileSync.mockReturnValue('csv-content');
  });

  describe('importRecipientsCSV', () => {
    it('should return zeroed results for empty files', async () => {
      parse.mockReturnValue([]);

      const result = await importRecipientsCSV('/tmp/recipients.csv');

      expect(result).toEqual({ total_processed: 0, imported: 0, skipped: 0, errors: 0 });
    });

    it('should increment errors when recipient name is missing', async () => {
      parse.mockReturnValue([{ name: '   ' }]);

      const result = await importRecipientsCSV('/tmp/recipients.csv');

      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
      expect(recipientRepository.createOrGet).not.toHaveBeenCalled();
    });

    it('should increment imported when recipient is newly created', async () => {
      parse.mockReturnValue([{ name: 'Alice' }]);
      recipientRepository.createOrGet.mockResolvedValue({ recipient: { id: 1 }, created: true });

      const result = await importRecipientsCSV('/tmp/recipients.csv');

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should increment skipped when recipient already exists', async () => {
      parse.mockReturnValue([{ name: 'Alice' }]);
      recipientRepository.createOrGet.mockResolvedValue({ recipient: { id: 1 }, created: false });

      const result = await importRecipientsCSV('/tmp/recipients.csv');

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should swallow bank account create failures and continue', async () => {
      parse.mockReturnValue([{ name: 'Alice', bank_account: 'BE11 1111 1111 1111' }]);
      recipientRepository.createOrGet.mockResolvedValue({ recipient: { id: 1 }, created: true });
      recipientBankAccountRepository.createOrGet.mockRejectedValue(new Error('invalid iban'));

      const result = await importRecipientsCSV('/tmp/recipients.csv');

      expect(result.imported).toBe(1);
      expect(result.errors).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not add bank account'));
    });

    it('should create category and update default category only when null', async () => {
      parse.mockReturnValue([{ name: 'Alice', category: 'food:groceries' }]);
      recipientRepository.createOrGet.mockResolvedValue({ recipient: { id: 42 }, created: true });
      categoryRepository.createOrGet.mockResolvedValue({ category: { id: 9 }, created: true });
      query.mockResolvedValue({ rows: [] });

      await importRecipientsCSV('/tmp/recipients.csv');

      expect(categoryRepository.createOrGet).toHaveBeenCalledWith({ general: 'FOOD', detail: 'GROCERIES' });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('default_category_id IS NULL'),
        [9, 42]
      );
    });

    it('should warn and continue on invalid category format', async () => {
      parse.mockReturnValue([{ name: 'Alice', category: 'INVALID_FORMAT' }]);
      recipientRepository.createOrGet.mockResolvedValue({ recipient: { id: 1 }, created: true });

      const result = await importRecipientsCSV('/tmp/recipients.csv');

      expect(result.imported).toBe(1);
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid category format'));
    });

    it('should throw CSV parse errors with explicit prefix', async () => {
      parse.mockImplementation(() => {
        throw new Error('invalid quote at line 2');
      });

      await expect(importRecipientsCSV('/tmp/recipients.csv'))
        .rejects
        .toThrow('CSV parse error: invalid quote at line 2');
    });
  });

  describe('importCategoriesCSV', () => {
    it('should import using explicit category header column', async () => {
      parse.mockReturnValue([{ category: 'food:groceries' }]);
      categoryRepository.createOrGet.mockResolvedValue({ category: { id: 1 }, created: true });

      const result = await importCategoriesCSV('/tmp/categories.csv');

      expect(categoryRepository.createOrGet).toHaveBeenCalledWith({ general: 'FOOD', detail: 'GROCERIES' });
      expect(result.imported).toBe(1);
    });

    it('should fall back to first column when category header is missing', async () => {
      parse.mockReturnValue([{ custom_col: 'utilities:electricity' }]);
      categoryRepository.createOrGet.mockResolvedValue({ category: { id: 2 }, created: true });

      await importCategoriesCSV('/tmp/categories.csv');

      expect(categoryRepository.createOrGet).toHaveBeenCalledWith({ general: 'UTILITIES', detail: 'ELECTRICITY' });
    });

    it('should increment errors for invalid category format', async () => {
      parse.mockReturnValue([{ category: 'INVALID' }]);

      const result = await importCategoriesCSV('/tmp/categories.csv');

      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
    });

    it('should increment errors for empty general or detail parts', async () => {
      parse.mockReturnValue([{ category: 'FOOD:' }, { category: ':GROCERIES' }]);

      const result = await importCategoriesCSV('/tmp/categories.csv');

      expect(result.errors).toBe(2);
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
    });

    it('should map createOrGet outcomes to imported and skipped', async () => {
      parse.mockReturnValue([{ category: 'FOOD:GROCERIES' }, { category: 'TRANSPORT:FUEL' }]);
      categoryRepository.createOrGet
        .mockResolvedValueOnce({ category: { id: 1 }, created: true })
        .mockResolvedValueOnce({ category: { id: 2 }, created: false });

      const result = await importCategoriesCSV('/tmp/categories.csv');

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('should throw CSV parse errors with explicit prefix', async () => {
      parse.mockImplementation(() => {
        throw new Error('delimiter issue');
      });

      await expect(importCategoriesCSV('/tmp/categories.csv'))
        .rejects
        .toThrow('CSV parse error: delimiter issue');
    });
  });
});
