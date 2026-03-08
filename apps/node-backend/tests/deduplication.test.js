/**
 * Deduplication Service Tests
 * Mirrors: apps/backend/services/deduplication_service.py
 */

import { describe, it, expect } from 'vitest';
import { createTransactionHash } from '../src/services/deduplication.js';

describe('DeduplicationService', () => {
  describe('createTransactionHash', () => {
    it('creates hash from raw data', () => {
      const txData = {
        date: new Date('2024-01-15'),
        amount: -50.00,
        recipient: 'TEST STORE',
        memo: 'Groceries',
        rawData: 'some,raw,csv,line',
      };
      const hash = createTransactionHash(txData);
      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(64); // SHA256 hex
    });

    it('creates hash from fields when no raw data', () => {
      const txData = {
        date: new Date('2024-01-15'),
        amount: -50.00,
        recipient: 'TEST STORE',
        memo: 'Groceries',
        rawData: '',
      };
      const hash = createTransactionHash(txData);
      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(64);
    });

    it('produces consistent hashes', () => {
      const txData = {
        date: new Date('2024-01-15'),
        amount: -50.00,
        recipient: 'TEST STORE',
        memo: 'Groceries',
        rawData: 'identical,raw,data',
      };
      const hash1 = createTransactionHash(txData);
      const hash2 = createTransactionHash(txData);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different data', () => {
      const txData1 = {
        date: new Date('2024-01-15'),
        amount: -50.00,
        recipient: 'STORE A',
        memo: '',
        rawData: 'data1',
      };
      const txData2 = {
        date: new Date('2024-01-15'),
        amount: -50.00,
        recipient: 'STORE B',
        memo: '',
        rawData: 'data2',
      };
      expect(createTransactionHash(txData1)).not.toBe(createTransactionHash(txData2));
    });
  });
});
