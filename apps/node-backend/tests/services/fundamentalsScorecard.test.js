import { describe, it, expect } from 'vitest';
import { fundamentalsScorecard } from '../../src/services/research/fundamentalsScorecard.js';

describe('fundamentalsScorecard', () => {
  it('returns an unknown grade with no flags for empty input', () => {
    expect(fundamentalsScorecard(undefined)).toMatchObject({ score: null, grade: 'unknown', evaluated: 0 });
    expect(fundamentalsScorecard({}).evaluated).toBe(0);
  });

  it('skips missing fields rather than penalizing them', () => {
    const r = fundamentalsScorecard({ currentRatio: 2 });
    expect(r.evaluated).toBe(1);
    expect(r.flags[0]).toMatchObject({ metric: 'currentRatio', severity: 'ok', code: 'currentRatio.ok' });
    expect(r.score).toBe(100);
  });

  it('flags a weak balance sheet as high severity and tanks the score', () => {
    const r = fundamentalsScorecard({
      currentRatio: 0.8,      // risk
      debtToEquity: 3,        // risk
      interestCoverage: 1,    // risk
      profitMargin: -0.1,     // risk
      revenueGrowth: -0.05,   // warn
    });
    expect(r.score).toBeLessThan(40);
    expect(r.grade).toBe('poor');
    expect(r.counts.risk).toBeGreaterThanOrEqual(4);
    // Worst-first ordering.
    expect(r.flags[0].severity).toBe('risk');
  });

  it('scores a healthy company highly', () => {
    const r = fundamentalsScorecard({
      currentRatio: 2.5,
      quickRatio: 1.8,
      debtToEquity: 0.4,
      interestCoverage: 12,
      profitMargin: 0.22,
      operatingMargin: 0.3,
      grossMargin: 0.6,
      returnOnEquity: 0.25,
      freeCashFlow: 5e9,
      revenueGrowth: 0.15,
      pe: 22,
      payoutRatio: 0.3,
    });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.grade).toBe('strong');
    expect(r.counts.risk).toBe(0);
  });

  it('grades the current-ratio thresholds', () => {
    expect(fundamentalsScorecard({ currentRatio: 0.8 }).flags[0].severity).toBe('risk');
    expect(fundamentalsScorecard({ currentRatio: 1.2 }).flags[0].severity).toBe('caution');
    expect(fundamentalsScorecard({ currentRatio: 2 }).flags[0].severity).toBe('ok');
  });

  it('flags a dividend that exceeds earnings', () => {
    const r = fundamentalsScorecard({ payoutRatio: 1.3 });
    expect(r.flags[0]).toMatchObject({ metric: 'payoutRatio', severity: 'warn' });
  });
});
