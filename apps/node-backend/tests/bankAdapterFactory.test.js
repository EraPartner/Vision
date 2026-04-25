/**
 * Bank Adapter Factory Tests
 * Tests the factory pattern and generic CSV adapter.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAdapter, getSupportedBanks } from '../src/services/bankAdapters.js';

function writeTempCSV(content) {
  const tmpPath = path.join(os.tmpdir(), `test_factory_${Date.now()}.csv`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

describe('BankAdapterFactory', () => {
  let tmpPath;

  afterEach(() => {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it('creates belfius adapter', async () => {
    const parser = createAdapter('belfius');
    expect(typeof parser).toBe('function');
  });

  it('creates revolut adapter', async () => {
    const parser = createAdapter('revolut');
    expect(typeof parser).toBe('function');
  });

  it('creates kbc adapter', async () => {
    const parser = createAdapter('kbc');
    expect(typeof parser).toBe('function');
  });

  it('is case-insensitive', async () => {
    expect(() => createAdapter('BELFIUS')).not.toThrow();
    expect(() => createAdapter('Revolut')).not.toThrow();
    expect(() => createAdapter('KBC')).not.toThrow();
  });

  it('throws for unsupported bank', async () => {
    expect(() => createAdapter('UnknownBank')).toThrow('No configuration found');
  });

  it('creates generic adapter with custom config', async () => {
    const config = {
      bank_name: 'TestBank',
      date_format: '%Y-%m-%d',
      separator: ',',
      encoding: 'utf-8',
      skip_rows: 0,
      column_mapping: {
        date: 'Date',
        recipient: 'Description',
        amount: 'Amount',
        memo: '',
      },
    };
    const parser = createAdapter('TestBank', config);
    expect(typeof parser).toBe('function');
  });

  it('generic adapter parses CSV correctly', async () => {
    const config = {
      bank_name: 'TestBank',
      date_format: '%Y-%m-%d',
      separator: ',',
      encoding: 'utf-8',
      skip_rows: 0,
      column_mapping: {
        date: 'Date',
        recipient: 'Description',
        amount: 'Amount',
        memo: '',
      },
    };
    const csv = `Date,Description,Amount
2024-01-15,Grocery Store,-50.00
2024-01-16,Salary,2000.00
`;
    tmpPath = writeTempCSV(csv);
    const parser = createAdapter('TestBank', config);
    const txns = await parser(tmpPath);
    expect(txns).toHaveLength(2);
    expect(txns[0].recipient).toBe('Grocery Store');
    expect(txns[0].amount).toBe(-50.00);
    expect(txns[1].amount).toBe(2000.00);
    expect(txns[0].bankAccount).toBe('TestBank');
  });

  describe('getSupportedBanks', () => {
    it('returns supported banks', async () => {
      const banks = getSupportedBanks();
      expect(banks).toContain('belfius');
      expect(banks).toContain('revolut');
      expect(banks).toContain('kbc');
    });
  });
});
