// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAdminToken,
  setAdminToken,
  clearAdminToken,
  hasAdminToken,
} from '@/lib/adminToken';

// window.localStorage is unavailable under the sandboxed jsdom/Bun runner
// (Bun's experimental localStorage needs --localstorage-file) — back it with an
// in-memory stub so the "never localStorage" assertion stays meaningful.
function installMemoryLocalStorage() {
  const backing = new Map<string, string>();
  const stub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k, v) => void backing.set(k, String(v)),
    removeItem: (k) => void backing.delete(k),
    clear: () => backing.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true });
}

describe('adminToken storage', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    window.sessionStorage.clear();
  });

  it('is null/false when unset', () => {
    expect(getAdminToken()).toBeNull();
    expect(hasAdminToken()).toBe(false);
  });

  it('stores and reads a token (trimmed)', () => {
    setAdminToken('  s3cret-token  ');
    expect(getAdminToken()).toBe('s3cret-token');
    expect(hasAdminToken()).toBe(true);
  });

  it('treats a blank value as clearing the token', () => {
    setAdminToken('abc');
    setAdminToken('   ');
    expect(getAdminToken()).toBeNull();
    expect(hasAdminToken()).toBe(false);
  });

  it('clears the token', () => {
    setAdminToken('abc');
    clearAdminToken();
    expect(getAdminToken()).toBeNull();
  });

  it('persists only in sessionStorage, never localStorage', () => {
    setAdminToken('abc');
    expect(window.sessionStorage.getItem('vision.adminToken')).toBe('abc');
    expect(window.localStorage.getItem('vision.adminToken')).toBeNull();
  });
});
