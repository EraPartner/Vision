import { describe, it, expect } from 'vitest';
import { getTaxTable, getAvailableYears } from '../src/services/reports/belgianTaxTables.js';

describe('belgianTaxTables', () => {
  it('has a 2026 entry with the CGT regime (was missing → fell back to 2025)', () => {
    const t = getTaxTable(2026);
    expect(t.year).toBe(2026);
    expect(t.capitalGainsTaxRate).toBe(0.10);
    expect(t.capitalGainsTaxExemptionSingle).toBe(10_000);
    expect(t.capitalGainsTaxExemptionMarried).toBe(20_000);
    expect(t.dividendExemption).toBe(859); // unchanged from 2025
    expect(t.approximated).toBeUndefined();
  });

  it('pre-2026 years carry 0 CGT (regime not yet in force)', () => {
    expect(getTaxTable(2025).capitalGainsTaxRate).toBe(0);
    expect(getTaxTable(2024).capitalGainsTaxRate).toBe(0);
  });

  it('marks an unknown year as approximated from the latest known year', () => {
    const t = getTaxTable(2030);
    expect(t.approximated).toBe(true);
    expect(t.approximatedFrom).toBe(2026);
    expect(t.capitalGainsTaxRate).toBe(0.10); // uses 2026 numbers
  });

  it('TOB caps follow the rate: 0.35% → €1,600 (the €4,000 cap belongs to the 1.32% rate)', () => {
    const { tob } = getTaxTable(2026);
    expect(tob.bonds).toEqual({ rate: 0.0012, cap: 1300 });
    expect(tob.sharesAndOther).toEqual({ rate: 0.0035, cap: 1600 });
    expect(tob.accumulatingFunds).toEqual({ rate: 0.0132, cap: 4000 });
    expect(tob.distributingFunds).toEqual({ rate: 0.0012, cap: 1300 });
  });

  it('lists available years ascending incl. 2026', () => {
    expect(getAvailableYears()).toEqual([2024, 2025, 2026]);
  });
});
