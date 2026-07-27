/**
 * Drift badge label + tone (§3 F1, WP-B5).
 *
 * A drift badge used to say only "Drift: +€15,50" in destructive red, which
 * conflates two very different situations:
 *
 *   - a FRESH statement reading that disagrees with the ledger — something is
 *     genuinely missing or wrong (destructive tone), and
 *   - a statement reading stamped months ago that the ledger has simply moved
 *     on from — nothing is broken, the anchor is just old (warning tone).
 *
 * This helper renders the badge text with the statement's as-of date attached
 * ("Drift +€15,50 · statement 03/06/2026") and picks the tone from that date,
 * so the Accounts hub, the account detail header and the dashboard
 * BankBalancesWidget cards can't drift apart in wording or colour.
 *
 * Date handling follows the app's YMD convention throughout. The accounts list
 * endpoint already emits `statement_balance_date` as a bare YYYY-MM-DD string
 * (`to_char(...)` in accountRepository.js's COLUMNS), so the slice below is
 * defense-in-depth for any other path that hands us a full ISO timestamp — not
 * a correction of the list payload. The staleness comparison runs on two
 * YYYY-MM-DD strings converted through the same UTC constructor, never on mixed
 * local/UTC Date instances, which shift a day either side of midnight.
 */
import { useCallback } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { formatDateStringWithAppSettings, toYmd } from '@/components/shared/dateUtils';
import type { Account } from '@/types/api';

/**
 * A statement reading older than this many days is treated as stale: its drift
 * is reported in warning (amber) tone rather than destructive.
 */
export const STALE_STATEMENT_DAYS = 45;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The account's statement as-of date as a plain YYYY-MM-DD string, or undefined
 * when it is absent/unparseable. The list endpoint sends a bare YYYY-MM-DD; the
 * slice is defensive, so a full ISO timestamp from any other source degrades to
 * its calendar day rather than poisoning a comparison.
 */
export function statementYmd(
    account: Pick<Account, 'statement_balance_date'>,
): string | undefined {
    const raw = account.statement_balance_date;
    if (!raw) return undefined;
    const ymd = raw.slice(0, 10);
    return YMD_RE.test(ymd) ? ymd : undefined;
}

/** Midnight-UTC epoch ms for a YYYY-MM-DD calendar day (no timezone shift). */
function ymdToUtcMs(ymd: string): number {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

/**
 * Whole calendar days between two YYYY-MM-DD days. Both endpoints go through
 * the same UTC constructor, so the difference is DST- and timezone-proof.
 */
export function daysBetweenYmd(fromYmd: string, toYmdStr: string): number {
    return Math.round((ymdToUtcMs(toYmdStr) - ymdToUtcMs(fromYmd)) / 86_400_000);
}

/**
 * True when a statement reading is older than STALE_STATEMENT_DAYS.
 * `todayYmd` defaults to the user's LOCAL calendar day (toYmd uses local
 * getters), which is the day the user thinks it is.
 */
export function isStatementStale(
    ymd: string | undefined,
    todayYmd: string = toYmd(new Date()),
): boolean {
    if (!ymd) return false;
    return daysBetweenYmd(ymd, todayYmd) > STALE_STATEMENT_DAYS;
}

export interface DriftBadgeContent {
    /** Badge text, e.g. "Drift +€15,50 · statement 03/06/2026". */
    label: string;
    /** The statement reading behind this drift is older than ~45 days. */
    stale: boolean;
    /** `badgeVariants` variant carrying the tone — never a bespoke colour. */
    variant: 'destructive' | 'warning';
    /** Tooltip text; the stale case explains that age, not breakage. */
    tooltip: string;
    /** Statement as-of date (YYYY-MM-DD) when one is stamped. */
    statementDate?: string;
}

/**
 * Returns a formatter mapping an account to its drift badge content, or null
 * when the account carries no (non-zero) drift.
 */
export function useDriftBadge(): (account: Account) => DriftBadgeContent | null {
    const { t } = useLanguage();
    const fmtCur = useCurrencyFormatter();
    const { appSettings } = useAppSettings();

    return useCallback(
        (account: Account): DriftBadgeContent | null => {
            const drift = account.drift;
            if (drift == null || drift === 0) return null;

            // Sign is explicit for a positive drift (the statement is ahead of
            // the ledger); the formatter already renders the minus otherwise.
            const amount = `${drift > 0 ? '+' : ''}${fmtCur(drift, account.currency)}`;
            const statementDate = statementYmd(account);
            const stale = isStatementStale(statementDate);

            // The "·" separator lives here rather than inside a locale string:
            // the locale generator normalizes U+00B7 to a full stop, and the
            // same middle-dot meta separator is composed in TSX elsewhere
            // (e.g. the hub card's "EUR · {institution}" line).
            const base = t('accounts.driftBadge', { amount });
            return {
                label: statementDate
                    ? `${base} · ${t('accounts.driftBadgeStatement', {
                        date: formatDateStringWithAppSettings(statementDate, appSettings.dateFormat),
                    })}`
                    : base,
                stale,
                variant: stale ? 'warning' : 'destructive',
                tooltip: stale ? t('accounts.driftStaleTooltip') : t('accounts.driftTooltip'),
                statementDate,
            };
        },
        [t, fmtCur, appSettings.dateFormat],
    );
}
