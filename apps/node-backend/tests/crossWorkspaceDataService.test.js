import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../src/services/portfolio/portfolioSummaryService.js', () => ({
  getPortfolioSummary: vi.fn(),
}));
vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  // Identity conversion keeps the arithmetic checkable; per-currency behaviour is
  // exercised by asserting it is only called for non-target currencies.
  convertToCurrency: vi.fn(async (amount) => amount),
}));

import { query } from '../src/database/connection.js';
import { getPortfolioSummary } from '../src/services/portfolio/portfolioSummaryService.js';
import { convertToCurrency } from '../src/services/currency/currencyConversionService.js';
import { assembleRebalanceInputs } from '../src/services/crossWorkspaceDataService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assembleRebalanceInputs (ADR-098)', () => {
  it('rolls asset classes up to allocation sleeves and sums spendable cash', async () => {
    getPortfolioSummary.mockResolvedValue({
      summaries: [
        { id: 1, asset_class: 'stock', currentValue: 1000, avgCostBasis: 0 },
        { id: 2, asset_class: 'etf', currentValue: 500, avgCostBasis: 0 },
        { id: 3, asset_class: 'bond', currentValue: 400, avgCostBasis: 0 },
        { id: 4, asset_class: 'metals', currentValue: 300, avgCostBasis: 0 },
        { id: 5, asset_class: 'crypto', currentValue: 250, avgCostBasis: 0 },
      ],
    });
    query.mockResolvedValue({
      rows: [
        { id: 10, name: 'Checking', currency: 'EUR', balance_parts: [{ currency: 'EUR', balance: '800' }] },
        { id: 11, name: 'Savings', currency: 'EUR', balance_parts: [{ currency: 'EUR', balance: '1200' }] },
      ],
    });

    const out = await assembleRebalanceInputs({ currency: 'EUR' });

    // stock + etf → stocks; bond → bonds; metals → gold; crypto keeps its key.
    expect(out.actualValues).toEqual({ stocks: 1500, bonds: 400, gold: 300, crypto: 250 });
    expect(out.availableCash).toBe(2000);
    expect(out.cashAccounts).toHaveLength(2);
    // Same-currency balances must NOT hit FX conversion.
    expect(convertToCurrency).not.toHaveBeenCalled();
  });

  it('converts non-target account currencies to the target', async () => {
    getPortfolioSummary.mockResolvedValue({ summaries: [] });
    query.mockResolvedValue({
      rows: [{ id: 10, name: 'USD cash', currency: 'USD', balance_parts: [{ currency: 'USD', balance: '100' }] }],
    });

    await assembleRebalanceInputs({ currency: 'EUR' });

    expect(convertToCurrency).toHaveBeenCalledWith(100, 'USD', 'EUR');
  });

  // The defect: the cross-currency lateral summed 100 EUR + 100 USD as bare
  // numbers and this service converted the 200 at the single rate of
  // `a.currency`. Each partition must be converted on its own instead.
  it('converts each currency partition of a multi-currency account separately', async () => {
    getPortfolioSummary.mockResolvedValue({ summaries: [] });
    // Rate-shaped stub for this case only (Once, so the suite-wide identity
    // conversion is restored afterwards): USD is worth half a EUR.
    convertToCurrency.mockImplementationOnce(async (amount) => amount * 0.5);
    query.mockResolvedValue({
      rows: [{
        id: 10,
        name: 'Wise',
        currency: 'EUR',
        balance_parts: [
          { currency: 'EUR', balance: '100' },
          { currency: 'USD', balance: '100' },
        ],
      }],
    });

    const out = await assembleRebalanceInputs({ currency: 'EUR' });

    expect(out.availableCash).toBe(150); // NOT (100 + 100) at one rate
    expect(out.cashAccounts).toEqual([{ id: 10, name: 'Wise', currency: 'EUR', balance: 150 }]);
    // The EUR partition is already in the target and must not hit FX at all.
    expect(convertToCurrency).toHaveBeenCalledTimes(1);
    expect(convertToCurrency).toHaveBeenCalledWith(100, 'USD', 'EUR');
  });

  // A spendable account with no ledger rows keeps its (zero) entry: the
  // aggregated per-currency lateral is a LEFT join, so it yields a NULL parts
  // array rather than dropping the account.
  it('keeps a spendable account with no ledger activity as a zero entry', async () => {
    getPortfolioSummary.mockResolvedValue({ summaries: [] });
    query.mockResolvedValue({ rows: [{ id: 12, name: 'Fresh', currency: 'EUR', balance_parts: null }] });

    const out = await assembleRebalanceInputs({ currency: 'EUR' });

    expect(out.availableCash).toBe(0);
    expect(out.cashAccounts).toEqual([{ id: 12, name: 'Fresh', currency: 'EUR', balance: 0 }]);
  });
});
