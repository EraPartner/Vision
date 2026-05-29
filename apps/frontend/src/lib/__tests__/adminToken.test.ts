// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAdminToken,
  setAdminToken,
  clearAdminToken,
  hasAdminToken,
} from '@/lib/adminToken';

describe('adminToken storage', () => {
  beforeEach(() => {
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
