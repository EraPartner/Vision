/**
 * Shared logger mock used by `vi.mock('.../config/logger.js', ...)` factories.
 *
 * Usage:
 *   import { mockLogger } from '../helpers/mockLogger.js';
 *   vi.mock('../src/config/logger.js', () => ({ logger: mockLogger() }));
 *
 * The function name is prefixed with `mock` so it may be referenced inside a
 * hoisted `vi.mock` factory.
 */
import { vi } from 'vitest';

/**
 * @returns {{ info: import('vitest').Mock, error: import('vitest').Mock, warn: import('vitest').Mock, debug: import('vitest').Mock }}
 */
export function mockLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}
