import { describe, it, expect } from 'vitest';
import { isExpandableGroup, computeMasterToggleState } from './statisticsUtils';

// Extracted helper — mirror the implementation so tests stay pure (no DOM).
function lastDayOfMonth(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const day = new Date(year, month, 0).getDate();
  return `${period}-${String(day).padStart(2, '0')}`;
}

type PivotValueMode = 'absolute' | 'net' | 'income' | 'expense';

function buildDrillUrl(params: {
  categoryId?: number;
  categoryIds?: number[];
  period?: string;
  valueMode: PivotValueMode;
  label: string;
}): string {
  const { categoryId, categoryIds, period, valueMode, label } = params;
  const sp = new URLSearchParams();

  if (categoryId != null) sp.set('category_id', String(categoryId));
  else if (categoryIds && categoryIds.length > 0) sp.set('category_ids', categoryIds.join(','));

  if (period) {
    sp.set('start_date', `${period}-01`);
    sp.set('end_date', lastDayOfMonth(period));
  }

  if (valueMode === 'income') sp.set('transaction_type', 'income');
  else if (valueMode === 'expense') sp.set('transaction_type', 'expense');

  sp.set('filter_label', label);
  return `/transactions?${sp.toString()}`;
}

describe('lastDayOfMonth', () => {
  it('returns last day for January', () => {
    expect(lastDayOfMonth('2026-01')).toBe('2026-01-31');
  });

  it('returns last day for February in a leap year', () => {
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
  });

  it('returns last day for February in a non-leap year', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
  });

  it('returns last day for a 30-day month', () => {
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
  });
});

describe('buildDrillUrl', () => {
  it('detail row × month: sets category_id + date range', () => {
    const url = buildDrillUrl({ categoryId: 5, period: '2026-01', valueMode: 'absolute', label: 'Food — Jan 2026' });
    expect(url).toContain('category_id=5');
    expect(url).toContain('start_date=2026-01-01');
    expect(url).toContain('end_date=2026-01-31');
    expect(url).not.toContain('transaction_type');
    expect(url).toContain('filter_label=');
  });

  it('detail row × total: sets category_id, no date range', () => {
    const url = buildDrillUrl({ categoryId: 5, valueMode: 'expense', label: 'Food' });
    expect(url).toContain('category_id=5');
    expect(url).not.toContain('start_date');
    expect(url).toContain('transaction_type=expense');
  });

  it('group header × month: sets category_ids as comma-separated + date range', () => {
    const url = buildDrillUrl({ categoryIds: [1, 2, 3], period: '2026-03', valueMode: 'income', label: 'Food — Mar 2026' });
    expect(url).toContain('category_ids=1%2C2%2C3');
    expect(url).toContain('start_date=2026-03-01');
    expect(url).toContain('end_date=2026-03-31');
    expect(url).toContain('transaction_type=income');
    expect(url).not.toContain('category_id=');
  });

  it('group header × total: category_ids, no date', () => {
    const url = buildDrillUrl({ categoryIds: [4, 7], valueMode: 'net', label: 'Utilities' });
    expect(url).toContain('category_ids=4%2C7');
    expect(url).not.toContain('start_date');
    expect(url).not.toContain('transaction_type');
  });

  it('footer × month: only date range, no category filter', () => {
    const url = buildDrillUrl({ period: '2026-06', valueMode: 'absolute', label: 'Jun 2026' });
    expect(url).not.toContain('category_id');
    expect(url).toContain('start_date=2026-06-01');
    expect(url).toContain('end_date=2026-06-30');
  });

  it('net mode adds no transaction_type param', () => {
    const url = buildDrillUrl({ categoryId: 1, valueMode: 'net', label: 'Test' });
    expect(url).not.toContain('transaction_type');
  });

  it('income mode adds transaction_type=income', () => {
    const url = buildDrillUrl({ period: '2026-01', valueMode: 'income', label: 'Jan' });
    expect(url).toContain('transaction_type=income');
  });
});

describe('isExpandableGroup', () => {
  it('returns false for a flat category (single self-child)', () => {
    expect(isExpandableGroup({ general: 'FOOD', children: [{ detailName: 'FOOD' }] })).toBe(false);
  });

  it('returns true when at least one child has a different detailName', () => {
    expect(isExpandableGroup({ general: 'FOOD', children: [{ detailName: 'GROCERIES' }, { detailName: 'DINING' }] })).toBe(true);
  });

  it('returns true for a single child with a different detailName', () => {
    expect(isExpandableGroup({ general: 'FOOD', children: [{ detailName: 'GROCERIES' }] })).toBe(true);
  });

  it('returns false for an empty children array', () => {
    expect(isExpandableGroup({ general: 'FOOD', children: [] })).toBe(false);
  });
});

describe('computeMasterToggleState', () => {
  it('returns hasExpandable false when no expandable groups', () => {
    const result = computeMasterToggleState([], new Set());
    expect(result.hasExpandable).toBe(false);
    expect(result.allCollapsed).toBe(false);
  });

  it('returns allCollapsed true when every expandable group is in the set', () => {
    const result = computeMasterToggleState(['FOOD', 'TRANSPORT'], new Set(['FOOD', 'TRANSPORT']));
    expect(result.hasExpandable).toBe(true);
    expect(result.allCollapsed).toBe(true);
  });

  it('returns allCollapsed false when none are collapsed', () => {
    const result = computeMasterToggleState(['FOOD', 'TRANSPORT'], new Set());
    expect(result.hasExpandable).toBe(true);
    expect(result.allCollapsed).toBe(false);
  });

  it('returns allCollapsed false for mixed state', () => {
    const result = computeMasterToggleState(['FOOD', 'TRANSPORT'], new Set(['FOOD']));
    expect(result.hasExpandable).toBe(true);
    expect(result.allCollapsed).toBe(false);
  });
});
