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

import { COMPUTED_BALANCE_LATERAL } from '../src/repositories/accountBalanceSql.js';

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
