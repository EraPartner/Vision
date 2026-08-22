import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockComputeMetrics = vi.fn(() => null);
const mockComputeHeatmap = vi.fn(() => ({}));
const mockGetPortfolioSummary = vi.fn(async () => ({ summaries: [], totals: {} }));

vi.mock('../src/services/portfolioPerformanceSnapshotService.js', () => ({
  computeMetrics: mockComputeMetrics,
  computeHeatmap: mockComputeHeatmap,
}));

vi.mock('../src/services/portfolio/portfolioSummaryService.js', () => ({
  getPortfolioSummary: mockGetPortfolioSummary,
}));

const { buildPortfolioPerformancePayload } = await import(
  '../src/services/info/performanceHelpers.js'
);

function snapshot({
  date,
  invested,
  stocks,
  crypto,
  metals,
  cash,
  fxNeutral,
}) {
  const value = stocks + crypto + metals + cash;
  const gainLoss = value - invested;
  return {
    snapshot_date: date,
    invested: String(invested),
    value: String(value),
    value_fx_neutral: String(fxNeutral ?? value),
    stocks_etfs_value: String(stocks),
    crypto_value: String(crypto),
    metals_value: String(metals),
    cash_value: String(cash),
    stocks_etfs_invested: '0',
    crypto_invested: '0',
    metals_invested: '0',
    inflation_adjusted_value: String(value),
    gain_loss: String(gainLoss),
    return_pct: String(invested > 0 ? (gainLoss / invested) * 100 : 0),
    currency: 'EUR',
  };
}

async function build(rows) {
  return buildPortfolioPerformancePayload(
    'EUR',
    rows[0].snapshot_date,
    rows.at(-1).snapshot_date,
    rows,
    'all',
  );
}

describe('buildPortfolioPerformancePayload spike reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves a genuine one-day cash movement instead of re-smoothing the stored total', async () => {
    const rows = [
      snapshot({ date: '2026-01-01', invested: 18_000, stocks: 5_000, crypto: 2_000, metals: 1_000, cash: 10_000 }),
      snapshot({ date: '2026-01-02', invested: 68_000, stocks: 5_000, crypto: 2_000, metals: 1_000, cash: 60_000 }),
      snapshot({ date: '2026-01-03', invested: 18_360, stocks: 5_100, crypto: 2_040, metals: 1_020, cash: 10_200 }),
    ];

    const payload = await build(rows);
    const cleanedMiddle = mockComputeMetrics.mock.calls[0][0][1];

    expect(cleanedMiddle.value).toBe('68000');
    expect(cleanedMiddle.cash_value).toBe('60000');
    expect(cleanedMiddle.value_fx_neutral).toBe('68000');
    expect(payload.snapshots[1]).toEqual(expect.objectContaining({
      value: 68_000,
      value_fx_neutral: 68_000,
      gain_loss: 0,
      return_pct: 0,
    }));
  });

  it('keeps the stored decomposition authoritative and derives gain fields from the served value', async () => {
    const rows = [
      snapshot({ date: '2026-01-01', invested: 10_000, stocks: 5_000, crypto: 2_000, metals: 1_000, cash: 10_000 }),
      snapshot({ date: '2026-01-02', invested: 10_000, stocks: 5_000, crypto: 20_000, metals: 1_000, cash: 10_000 }),
      snapshot({ date: '2026-01-03', invested: 10_000, stocks: 5_100, crypto: 2_040, metals: 1_020, cash: 10_200 }),
    ];
    rows[1].gain_loss = '999999';
    rows[1].return_pct = '-999';

    const payload = await build(rows);
    const cleanedMiddle = mockComputeMetrics.mock.calls[0][0][1];
    const servedMiddle = payload.snapshots[1];
    const storedDecomposedValue = Number(cleanedMiddle.stocks_etfs_value)
      + Number(cleanedMiddle.crypto_value)
      + Number(cleanedMiddle.metals_value)
      + Number(cleanedMiddle.cash_value);

    expect(Number(cleanedMiddle.value)).toBeCloseTo(storedDecomposedValue, 8);
    expect(Number(cleanedMiddle.value_fx_neutral)).toBeCloseTo(storedDecomposedValue, 8);
    expect(Number(cleanedMiddle.gain_loss)).toBeCloseTo(Number(cleanedMiddle.value) - 10_000, 8);
    expect(Number(cleanedMiddle.return_pct)).toBeCloseTo(
      (Number(cleanedMiddle.gain_loss) / 10_000) * 100,
      8,
    );
    expect(servedMiddle.gain_loss).toBeCloseTo(servedMiddle.value - 10_000, 8);
    expect(servedMiddle.return_pct).toBeCloseTo((servedMiddle.gain_loss / 10_000) * 100, 8);
  });
});
