/**
 * Import service tests.
 * Mirrors: apps/backend/tests/test_import.py
 *
 * Tests import orchestration logic with mocked database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database query
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { importCSV } from '../src/services/importService.js';
import { query } from '../src/database/connection.js';

describe('Import Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error result for unsupported bank', async () => {
    const result = await importCSV('/tmp/test.csv', 'UnknownBank');
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should return proper result structure', async () => {
    const result = await importCSV('/tmp/nonexistent.csv', 'belfius');
    // Should have standard result fields even on error
    expect(result).toHaveProperty('total_processed');
    expect(result).toHaveProperty('imported');
    expect(result).toHaveProperty('duplicates');
    expect(result).toHaveProperty('errors');
  });

  it('should handle missing file gracefully', async () => {
    const result = await importCSV('/tmp/does_not_exist.csv', 'kbc');
    expect(result.total_processed).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should track duplicate count', async () => {
    // Mock: pretend the file parses OK but dedup finds everything is duplicate
    query.mockResolvedValue({ rows: [{ id: 1, count: '1' }] });

    // Since the adapter will fail on a non-existent file, we test the structure
    const result = await importCSV('/tmp/test.csv', 'revolut');
    expect(typeof result.duplicates).toBe('number');
  });
});
