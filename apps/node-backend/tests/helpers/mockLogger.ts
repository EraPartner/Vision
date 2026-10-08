/**
 * Shared logger mock used by `vi.mock('.../config/logger.ts', ...)` factories.
 *
 * Usage:
 *   import { mockLogger } from '../helpers/mockLogger.ts';
 *   vi.mock('../src/config/logger.ts', () => ({ logger: mockLogger() }));
 *
 * The function name is prefixed with `mock` so it may be referenced inside a
 * hoisted `vi.mock` factory.
 */
import { vi } from 'vitest';
import type { Mock } from 'vitest';

export interface LoggerMock {
  info: Mock;
  error: Mock;
  warn: Mock;
  debug: Mock;
}

export function mockLogger(): LoggerMock {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}
