import { describe, it, expect } from 'vitest';
// Import via the package root export map — exercises the new index.js re-export
// as well as the module itself (there is no backend re-export shim for category).
import { formatCategoryName, parseCategoryName } from '@vision/shared-utils';

describe('formatCategoryName', () => {
  it('joins general and detail with a colon (no spaces)', () => {
    expect(formatCategoryName('FOOD', 'Groceries')).toBe('FOOD:Groceries');
  });

  it('collapses to just general when detail is empty', () => {
    expect(formatCategoryName('FOOD', '')).toBe('FOOD');
  });

  it('collapses to just general when detail is missing / nullish', () => {
    expect(formatCategoryName('FOOD')).toBe('FOOD');
    expect(formatCategoryName('FOOD', null)).toBe('FOOD');
    expect(formatCategoryName('FOOD', undefined)).toBe('FOOD');
  });

  it('trims both parts', () => {
    expect(formatCategoryName('  FOOD ', '  Groceries ')).toBe('FOOD:Groceries');
    expect(formatCategoryName('  FOOD ', '   ')).toBe('FOOD');
  });

  it('preserves colons inside the detail text', () => {
    expect(formatCategoryName('FOOD', 'Sub:Item')).toBe('FOOD:Sub:Item');
  });
});

describe('parseCategoryName', () => {
  it('splits a GENERAL:DETAIL string', () => {
    expect(parseCategoryName('FOOD:Groceries')).toEqual({ general: 'FOOD', detail: 'Groceries' });
  });

  it('returns an empty detail when there is no colon', () => {
    expect(parseCategoryName('FOOD')).toEqual({ general: 'FOOD', detail: '' });
  });

  it('splits on the FIRST colon only, keeping colons in the detail', () => {
    expect(parseCategoryName('FOOD:Sub:Item')).toEqual({ general: 'FOOD', detail: 'Sub:Item' });
  });

  it('trims each part', () => {
    expect(parseCategoryName('  FOOD : Groceries ')).toEqual({ general: 'FOOD', detail: 'Groceries' });
  });

  it('handles nullish input', () => {
    expect(parseCategoryName(null)).toEqual({ general: '', detail: '' });
    expect(parseCategoryName(undefined)).toEqual({ general: '', detail: '' });
  });
});

describe('round-trip', () => {
  it('parse(format(g, d)) recovers the trimmed pair', () => {
    for (const [g, d] of [['FOOD', 'Groceries'], ['HOUSING', 'Rent'], ['A', 'B:C']]) {
      expect(parseCategoryName(formatCategoryName(g, d))).toEqual({ general: g, detail: d });
    }
  });

  it('format(parse(str)) recovers the string for a detailless category', () => {
    const { general, detail } = parseCategoryName('FOOD');
    expect(formatCategoryName(general, detail)).toBe('FOOD');
  });
});
