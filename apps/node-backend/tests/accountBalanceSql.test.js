/**
 * Shape tests for the shared computed-balance lateral (ADR-094 / WP-A1).
 *
 * The lateral is a SQL fragment executed by Postgres, so its arithmetic can't
 * be exercised without a live DB — what CAN be locked down here is the
 * contract every consumer (accountRepository, infoRepositoryBanks,
 * infoRepositoryNetWorth, reconcileService, crossWorkspaceDataService)
 * depends on: the exposed columns, the anchor+delta structure, and the
 * day-shift-safe date formatting. The three fixture *semantics* (manual-only,
 * stamped+manual, liability) are asserted at the repository level in
 * infoRepoBanks.test.js / infoRepository.test.js.
 */
import { describe, expect, it } from 'vitest';

import {
  COMPUTED_BALANCE_LATERAL,
  computedBalanceByCurrencyLateral,
  computedBalanceSeriesCtes,
} from '../src/repositories/accountBalanceSql.js';

describe('COMPUTED_BALANCE_LATERAL', () => {
  it('exposes balance, anchor_date and post_anchor_count (WP-A1 provenance)', () => {
    expect(COMPUTED_BALANCE_LATERAL).toContain('AS balance');
    expect(COMPUTED_BALANCE_LATERAL).toContain('AS anchor_date');
    expect(COMPUTED_BALANCE_LATERAL).toContain('AS post_anchor_count');
  });

  it('keeps the one-row LEFT JOIN LATERAL contract aliased lb over account alias a', () => {
    // Consumers LEFT JOIN and read `lb.*`; the account must be aliased `a`.
    expect(COMPUTED_BALANCE_LATERAL.trim().startsWith('LEFT JOIN LATERAL')).toBe(true);
    expect(COMPUTED_BALANCE_LATERAL).toContain(') lb ON true');
    expect(COMPUTED_BALANCE_LATERAL).toContain('t.account_id = a.id');
  });

  it('anchors on the latest stamped active row and sums strictly-after activity', () => {
    // The `balance IS NOT NULL` predicate may appear ONLY inside the anchor
    // CTE (picking the stamp) — never as a population gate on the result.
    expect(COMPUTED_BALANCE_LATERAL).toContain('WITH anchor AS');
    expect(COMPUTED_BALANCE_LATERAL).toContain('t.balance IS NOT NULL');
    expect(COMPUTED_BALANCE_LATERAL).toContain('ORDER BY t.date DESC, t.id DESC');
    // Strictly-after tuple comparison + the no-stamp Σ(amount) fallback.
    expect(COMPUTED_BALANCE_LATERAL).toContain('(t2.date, t2.id) > (SELECT date, id FROM anchor)');
    expect(COMPUTED_BALANCE_LATERAL).toContain('NOT EXISTS (SELECT 1 FROM anchor)');
    // The delta CTE both sums and counts the same row set, so
    // post_anchor_count is "entries since the statement" (or total entries
    // when nothing is stamped).
    expect(COMPUTED_BALANCE_LATERAL).toContain('COUNT(*) AS post_anchor_count');
  });

  it('emits anchor_date via to_char so pg never returns a local-midnight JS Date', () => {
    expect(COMPUTED_BALANCE_LATERAL).toContain("to_char(date, 'YYYY-MM-DD')");
  });

  it('only considers active rows', () => {
    const inactiveSafe = COMPUTED_BALANCE_LATERAL
      .split('\n')
      .filter((l) => l.includes('FROM transactions'));
    expect(inactiveSafe.length).toBeGreaterThan(0);
    // Every transactions scan in the fragment is is_active-gated.
    expect(COMPUTED_BALANCE_LATERAL.match(/is_active = true/g)?.length).toBe(2);
  });
});

describe('computedBalanceByCurrencyLateral', () => {
  const sql = computedBalanceByCurrencyLateral({ account: 'a.id' });

  it('partitions every part of the computation by currency', () => {
    // The defect it fixes is a cross-currency SUM: the currency list, the
    // anchor probe and the delta sum must ALL be constrained to one currency,
    // or a partition silently absorbs another currency's rows again.
    expect(sql).toContain(`GROUP BY COALESCE(t.currency, 'EUR')`);
    expect(sql).toContain(`AND COALESCE(t.currency, 'EUR') = ccy.currency`);
    expect(sql).toContain(`AND COALESCE(t2.currency, 'EUR') = ccy.currency`);
  });

  it('keeps the anchor+delta structure, per partition', () => {
    expect(sql).toContain('t.balance IS NOT NULL');
    expect(sql).toContain('ORDER BY t.date DESC, t.id DESC');
    expect(sql).toContain('(anch.date IS NULL OR (t2.date, t2.id) > (anch.date, anch.id))');
    expect(sql.match(/is_active = true/g)?.length).toBe(3);
  });

  it('is set-returning and aliased, exposing currency and balance', () => {
    expect(sql.trim().startsWith('JOIN LATERAL')).toBe(true);
    expect(sql).toContain(') bal ON true');
    expect(sql).toContain('AS balance');
    // It is a CURRENT balance: it carries no per-partition FX date, because
    // callers must convert it at today's rate (the day the chart ends on), not
    // at the partition's last activity.
    expect(sql).not.toContain('last_activity');
    expect(computedBalanceByCurrencyLateral({ account: 'a.id', alias: 'x' })).toContain(') x ON true');
  });
});

describe('computedBalanceSeriesCtes', () => {
  it('ends in a balance_series CTE over the caller-supplied grid CTEs', () => {
    const sql = computedBalanceSeriesCtes();
    expect(sql).toContain('balance_series AS (');
    expect(sql).toContain('JOIN account_list bs_al ON bs_al.account_id = t.account_id');
    // Spliced into an existing WITH chain: no leading WITH, no trailing comma.
    expect(sql.trim().startsWith('WITH')).toBe(false);
    expect(sql.trim().endsWith(')')).toBe(true);
  });

  it('fills quiet days by expanding spans, never by joining a dense grid', () => {
    // A LEFT JOIN of the grid against the (statistics-less) day-end CTE is what
    // the planner turned into an O(days²) merge join with the day demoted to a
    // filter. Expanding each span with generate_series has no join to mis-plan.
    const sql = computedBalanceSeriesCtes();
    expect(sql).toContain("CROSS JOIN LATERAL generate_series(s.from_day, s.thru_day, interval '1 day')");
    expect(sql).toContain('LEAD(day) OVER (PARTITION BY account_id ORDER BY day) - 1');
    expect(sql).not.toContain('LEFT JOIN bs_day_end');
    expect(sql).not.toContain('JOIN days d');
  });

  it('reads balance as a stamp, never as a population gate — that gate WAS the bug', () => {
    // Manual-only accounts must reach the series. `balance IS NOT NULL` may
    // appear ONLY in the pre-window anchor probe (picking a stamp); the emitted
    // rows are filtered on day boundaries alone.
    const sql = computedBalanceSeriesCtes();
    // Exactly two readings of `balance`, both of them "is this row a stamp?":
    // the pre-window anchor probe, and the carry-forward CASE.
    expect(sql.match(/balance IS NOT NULL/g)?.length).toBe(2);
    expect(sql).toContain('AND t.balance IS NOT NULL\n        AND t.date < (SELECT first_day FROM bs_span)');
    expect(sql).toContain('MAX(CASE WHEN balance IS NOT NULL');
    expect(sql).toContain('balance - cum]');
    // The only filter on the emitted rows is a day boundary.
    expect(sql).toContain('WHERE next_day IS DISTINCT FROM day');
  });

  it('bounds the walk at the grid and folds earlier activity into one opening row', () => {
    const sql = computedBalanceSeriesCtes();
    expect(sql).toContain('AND t.date >= (SELECT first_day FROM bs_span)');
    expect(sql).toContain('AND t.date <= (SELECT last_day FROM bs_span)');
    // The opening row is dated the day before the grid and carries the
    // anchor+delta balance as of then, in the `balance` column (i.e. as a
    // stamp), so the window pass never has to read pre-window rows.
    expect(sql).toContain('(SELECT first_day FROM bs_span) - 1 AS date');
    expect(sql).toContain('COALESCE(anch.balance, 0) + dlt.amount AS balance');
    expect(sql).toContain('GREATEST(date, (SELECT first_day FROM bs_span)) AS day');
  });

  it('partitions by currency only when asked, and only over active rows', () => {
    const cross = computedBalanceSeriesCtes();
    const perCcy = computedBalanceSeriesCtes({ byCurrency: true });
    expect(cross).toContain(`''::text AS currency`);
    expect(perCcy).toContain(`COALESCE(t.currency, 'EUR') AS currency`);
    // The partition follows the mode; the cross-currency form carries no
    // constant column in its sort keys.
    expect(perCcy).toContain('WINDOW bs_w AS (PARTITION BY account_id, currency ORDER BY date, id)');
    expect(cross).toContain('WINDOW bs_w AS (PARTITION BY account_id ORDER BY date, id)');
    // …and only the per-currency form confines a partition to one currency.
    expect(perCcy).toContain(`AND COALESCE(t.currency, 'EUR') = p.currency`);
    expect(cross).not.toContain('= p.currency');
    for (const sql of [cross, perCcy]) {
      expect(sql).toContain('WHERE t.is_active = true');
      expect(sql.match(/t\.is_active = true/g)?.length).toBeGreaterThanOrEqual(4);
    }
  });
});
