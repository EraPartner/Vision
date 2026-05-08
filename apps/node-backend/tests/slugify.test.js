import { describe, it, expect } from 'vitest';
import { slugify } from '../src/lib/slugify.js';

describe('slugify', () => {
  it('lowercases input', () => {
    expect(slugify('ROME')).toBe('rome');
  });

  it('trims leading and trailing whitespace', () => {
    expect(slugify('  rome  ')).toBe('rome');
  });

  it('replaces single space with hyphen', () => {
    expect(slugify('rome 2020')).toBe('rome-2020');
  });

  it('collapses whitespace runs to a single hyphen', () => {
    expect(slugify('rome   2020')).toBe('rome-2020');
  });

  it('strips non-alphanumeric non-hyphen characters', () => {
    expect(slugify('hello!world')).toBe('helloworld');
  });

  it('drops unicode characters (v1 known limitation)', () => {
    expect(slugify('café')).toBe('caf');
  });

  it('collapses multiple consecutive hyphens to one', () => {
    expect(slugify('a---b')).toBe('a-b');
  });

  it('strips leading and trailing hyphens after normalization', () => {
    expect(slugify('-rome-')).toBe('rome');
    expect(slugify('  --weird-- ')).toBe('weird');
  });

  it('handles Rome 2020 canonical example', () => {
    expect(slugify('Rome 2020')).toBe('rome-2020');
  });

  it('handles Portugal 2025 canonical example', () => {
    expect(slugify('Portugal 2025')).toBe('portugal-2025');
  });

  it('returns empty string for all-special-char input', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('---')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('coerces non-string via String()', () => {
    expect(slugify(42)).toBe('42');
  });
});
