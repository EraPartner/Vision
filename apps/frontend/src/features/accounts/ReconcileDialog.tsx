/**
 * Drift reconciliation workflow (ADR-094, Phase C — accounts rewrite).
 *
 * The drift badge on an account card (statement_balance − computed_balance) used
 * to be a dead-end `title` tooltip: the only way to clear a drift was Edit →
 * Advanced. This dialog, opened by clicking the badge, shows the statement figure,
 * the computed (ledger) figure and their difference, then offers two explicit
 * resolutions backed by POST /api/accounts/:id/reconcile:
 *
 *   - "accept"     — adopt the computed balance: the stored statement figure is
 *                    rewritten to match it (no transaction created).
 *   - "adjustment" — keep the statement as truth: the server stamps one balancing
 *                    'adjustment' ledger row so the computed balance rises to meet
 *                    it. Opt-in and balance-free, preserving the ADR-094
 *                    descriptive-only default.
 *
 * Either way the drift collapses to 0 and every balance/net-worth view refreshes.
 *
 * WP-B5 (§3 F1) adds the flow's missing front half and its missing exit:
 *
 *   - a FRESH statement reading (amount + as-of date, defaulting to today) can be
 *     typed here instead of Edit → Advanced → two raw fields. The Difference row
 *     previews `entered − computed` live as the user types. Saving it PATCHes
 *     statement_balance/statement_balance_date through the normal account update
 *     path — no new endpoint. When a reading is entered, the two resolutions
 *     operate on THAT figure: the PATCH lands first, then the reconcile call
 *     reads it back server-side, so the resolved drift equals the preview.
 *   - "Show transactions since {date}" deep-links to /accounts/:id?since=YYYY-MM-DD,
 *     the filtered ledger the route has accepted since WP-B4 — the answer to
 *     "what happened after my last statement?" rather than a dead end.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check, Coins, ListFilter, Loader2, Plus, Save } from 'lucide-react';
import { apiClient } from '@/lib/api';
import type { ReconcileMode } from '@/lib/api/accounts';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { useBalanceProvenance } from '@/features/accounts/balanceProvenance';
import { statementYmd } from '@/features/accounts/driftBadge';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { invalidateAccountDerived, invalidateTransactionData } from '@/lib/queryKeys';
import { formatDateStringWithAppSettings, toYmd } from '@/components/shared/dateUtils';
import { parseDecimal } from '@/lib/decimal';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Account } from '@/types/api';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The shape the amount input's `pattern` attribute declares. That attribute is
 * decorative here — the inputs do not live in a <form>, so nothing enforces it —
 * and `parseLocaleNumber` is deliberately lenient (it replaces only the FIRST
 * separator, so "12,,3" parses as 12 and "1234..56" as 123456). Typos must not
 * pass as money, so the raw string is validated against the same shape in JS.
 */
const READING_SHAPE_RE = /^-?\d+([.,]\d+)?$/;

/**
 * Mirrors reconcileService.js's DRIFT_EPSILON: a difference below half a cent is
 * already reconciled, and the server rejects reconciling it. A fresh reading that
 * lands inside the epsilon IS the resolution — save it and stop, rather than
 * posting a reconcile the backend will refuse.
 */
const DRIFT_EPSILON = 0.005;

/**
 * Round to cents, half away from zero — the rule PostgreSQL NUMERIC(15,2) uses
 * when it stores the figure. The preview, the epsilon short-circuit and the
 * PATCH body must all agree with what will actually be stored: previewing
 * 900.005 as "no drift" while the server stores a 0.01 drift would pop a
 * success toast over an unresolved difference.
 */
function roundToCents(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(value) + Number.EPSILON) * 100)) / 100;
}

export function ReconcileDialog({ account, open, onOpenChange }: {
  account: Account;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const fmtCur = useCurrencyFormatter();
  const { appSettings } = useAppSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const statement = account.statement_balance ?? 0;
  const computed = account.computed_balance ?? 0;
  const delta = account.drift ?? statement - computed;
  // Provenance of the computed figure (WP-B2) — same subline as the hub card.
  const provenanceText = useBalanceProvenance()(account);

  // ── Fresh statement reading (§3 F1) ──────────────────────────────────────
  const [reading, setReading] = useState('');
  const [readingDate, setReadingDate] = useState(() => toYmd(new Date()));

  // Shape-check the RAW string first (parseLocaleNumber would happily turn
  // "12,,3" into 12), then round to cents so the previewed figure is exactly
  // the figure the server will store.
  const readingRaw = reading.trim();
  const parsedReading = READING_SHAPE_RE.test(readingRaw)
    ? roundToCents(parseDecimal(readingRaw, NaN))
    : NaN;
  const hasReading = Number.isFinite(parsedReading);
  /** Something was typed, but it is not a number we would dare send as money. */
  const readingInvalid = readingRaw !== '' && !hasReading;
  const readingDateValid = YMD_RE.test(readingDate);
  const canSaveReading = hasReading && readingDateValid;

  // Live preview: the drift the entered reading WOULD produce. Falls back to the
  // stored drift while the input is empty (or unusable), so the figure never
  // goes blank and never previews a half-typed number.
  const previewDrift = hasReading ? parsedReading - computed : delta;
  const previewIsZero = Math.abs(previewDrift) < DRIFT_EPSILON;

  // The statement date in play for the ledger deep-link: the freshly entered one
  // when a reading is being recorded, otherwise the stored anchor.
  const storedStatementDate = statementYmd(account);
  const sinceDate = (hasReading && readingDateValid ? readingDate : undefined)
    ?? storedStatementDate;

  // A reading dated BEFORE today is the dangerous case. The server computes
  // drift against the balance as of NOW (accountRepository.js) and stamps any
  // adjustment row with TODAY's date (reconcileService.js), so a difference that
  // is entirely explained by activity after the statement date would be
  // "resolved" by minting a bogus adjustment. Warn loudly; don't hard-block —
  // reconciling a days-old statement with no later activity is legitimate.
  const todayYmd = toYmd(new Date());
  const readingIsBackdated = hasReading && readingDateValid && readingDate < todayYmd;

  /** PATCH the entered reading onto the account (existing account update path). */
  const patchReading = () =>
    apiClient.updateAccount(account.id, {
      statement_balance: parsedReading,
      statement_balance_date: readingDate,
    });

  const saveReading = useMutation({
    mutationFn: patchReading,
    onSuccess: () => {
      // statement_balance feeds drift, which every account-derived view renders.
      invalidateAccountDerived(queryClient);
      toast.success(t('accounts.reconcile.readingSaved'));
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(t('accounts.reconcile.readingFailed'), { description: e.message }),
  });

  const reconcile = useMutation({
    mutationFn: async (mode: ReconcileMode) => {
      if (canSaveReading) {
        // Record the reading first so the server resolves against the figure the
        // user just typed — the resolved drift then equals the preview above.
        await patchReading();
        // A fresh reading that already matches the ledger leaves nothing to
        // resolve (and the server would reject a zero-drift reconcile).
        if (previewIsZero) return null;
      }
      return apiClient.reconcileAccount(account.id, mode);
    },
    onSuccess: (result, mode) => {
      // Balance, drift and every net-worth view derive from the ledger + statement.
      invalidateAccountDerived(queryClient);
      // The 'adjustment' mode stamps a real ledger row; the lists live under
      // ['transactions-virtual', …] (+ derived widgets), so invalidate them all.
      invalidateTransactionData(queryClient);
      if (result == null) toast.success(t('accounts.reconcile.readingSaved'));
      else toast.success(t(mode === 'accept' ? 'accounts.reconcile.acceptSaved' : 'accounts.reconcile.adjustSaved'));
      onOpenChange(false);
    },
    onError: (e: Error) => {
      // This mutation is two writes. The statement PATCH may already have landed
      // (and, for 'adjustment', so may the ledger row) when the second call
      // fails, so the cached drift/balance are stale the moment we error.
      // Refetch instead of leaving the badge showing a number the server no
      // longer holds for up to the 2-minute staleTime.
      invalidateAccountDerived(queryClient);
      invalidateTransactionData(queryClient);
      toast.error(t('accounts.reconcile.failed'), { description: e.message });
    },
  });

  // §3 F4 backfill: when NO statement anchor is stamped yet (anchor_date
  // absent — list-endpoint provenance, WP-A1), offer an ADDITIVE third path
  // that records the statement figure as the account's opening-balance anchor
  // (same POST /accounts/:id/opening-balance the OpeningBalanceDialog uses).
  const canBackfillOpening = !account.anchor_date && account.statement_balance != null;
  const backfill = useMutation({
    mutationFn: () =>
      apiClient.setOpeningBalance(account.id, {
        balance: statement,
        date: storedStatementDate ?? toYmd(new Date()),
        currency: account.currency,
      }),
    onSuccess: (result) => {
      invalidateAccountDerived(queryClient);
      invalidateTransactionData(queryClient);
      if (result.warning) toast.warning(t('accounts.openingBalance.saved'), { description: result.warning });
      else toast.success(t('accounts.openingBalance.saved'));
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(t('accounts.openingBalance.failed'), { description: e.message }),
  });

  const busy = reconcile.isPending || backfill.isPending || saveReading.isPending;
  const pendingMode = reconcile.variables;

  // A statement reading is only meaningful with its as-of date (ADR-094). If the
  // user typed a figure and then cleared the date, resolving would silently fall
  // back to the STORED statement — resolving a different number than the
  // preview shows. Block the resolutions instead of quietly disagreeing.
  const readingNeedsDate = hasReading && !readingDateValid;
  const resolutionsBlocked = busy || readingNeedsDate;

  const showLedgerSince = () => {
    onOpenChange(false);
    navigate(`/accounts/${account.id}?since=${sinceDate}`);
  };

  /**
   * The "read what happened since {date}" exit. Rendered ONCE: emphasized inside
   * the backdated-reading warning (where it is the recommended path), otherwise
   * as the quiet secondary exit at the foot of the dialog.
   */
  const ledgerSinceButton = (emphasized: boolean) => (
    <Button
      variant={emphasized ? 'outline' : 'ghost'}
      className={emphasized
        ? 'mt-2 w-full justify-start border-amber-500/50 text-sm font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-400'
        : 'w-full justify-start border-t border-border/50 pt-3 text-sm font-normal'}
      disabled={busy}
      onClick={showLedgerSince}
    >
      <ListFilter className="h-4 w-4 mr-1.5" />
      {t('accounts.reconcile.showSince', {
        date: formatDateStringWithAppSettings(sinceDate!, appSettings.dateFormat),
      })}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('accounts.reconcile.title')}</DialogTitle>
          <DialogDescription>
            {t('accounts.reconcile.description', { name: account.display_name || account.name })}
          </DialogDescription>
        </DialogHeader>

        {/* Statement vs computed, a fresh-reading input, and the live delta */}
        <div className="glass-thin rounded-xl p-4 text-sm">
          <dl>
            <div className="flex items-center justify-between py-1">
              <dt className="text-muted-foreground">{t('accounts.reconcile.statementLabel')}</dt>
              <dd className="tabular-nums font-medium">{fmtCur(statement, account.currency)}</dd>
            </div>
            <div className="flex items-center justify-between py-1">
              <dt className="text-muted-foreground">{t('accounts.reconcile.computedLabel')}</dt>
              <dd className="tabular-nums font-medium">{fmtCur(computed, account.currency)}</dd>
            </div>
            {provenanceText && (
              <div className="pb-1 text-right text-xs text-muted-foreground">
                {provenanceText}
              </div>
            )}
          </dl>

          {/* Recording a statement reading no longer means Edit → Advanced. */}
          <div className="mt-2 grid grid-cols-2 gap-3 border-t border-border/50 pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="reconcile-reading">{t('accounts.reconcile.readingLabel')}</Label>
              <Input
                id="reconcile-reading"
                type="text"
                inputMode="decimal"
                pattern="^-?[0-9]+([.,][0-9]+)?$"
                placeholder={fmtCur(statement, account.currency)}
                value={reading}
                disabled={busy}
                onChange={(e) => setReading(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reconcile-reading-date">{t('accounts.reconcile.readingDateLabel')}</Label>
              <Input
                id="reconcile-reading-date"
                type="date"
                value={readingDate}
                required={hasReading}
                disabled={busy}
                onChange={(e) => setReadingDate(e.target.value)}
              />
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('accounts.reconcile.readingHint')}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            disabled={busy || !canSaveReading}
            onClick={() => saveReading.mutate()}
          >
            {saveReading.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : <Save className="h-4 w-4 mr-1" />}
            {t('accounts.reconcile.readingSubmit')}
          </Button>

          <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2">
            <span className="font-medium">{t('accounts.reconcile.deltaLabel')}</span>
            <span
              data-testid="reconcile-delta"
              className={cn(
                'tabular-nums font-semibold',
                previewIsZero ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {previewDrift > 0 ? '+' : ''}{fmtCur(previewDrift, account.currency)}
            </span>
          </div>
          {hasReading && (
            <p className="mt-0.5 text-right text-xs text-muted-foreground">
              {t('accounts.reconcile.deltaPreview')}
            </p>
          )}
          {readingInvalid && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              {t('accounts.reconcile.readingInvalid')}
            </p>
          )}
          {readingNeedsDate && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              {t('accounts.reconcile.readingNeedsDate')}
            </p>
          )}
        </div>

        {/* Backdated reading: the difference may be later activity, not an error.
            Resolving with an adjustment here would double-count it. */}
        {readingIsBackdated && sinceDate && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('accounts.reconcile.backdatedWarning', {
                date: formatDateStringWithAppSettings(readingDate, appSettings.dateFormat),
              })}
            </p>
            {ledgerSinceButton(true)}
          </div>
        )}

        {/* Two explicit resolutions */}
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('accounts.reconcile.acceptTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('accounts.reconcile.acceptDescription')}</p>
            <Button
              variant="outline"
              className="mt-1 w-full"
              disabled={resolutionsBlocked}
              onClick={() => reconcile.mutate('accept')}
            >
              {busy && pendingMode === 'accept'
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Check className="h-4 w-4 mr-1" />}
              {t('accounts.reconcile.acceptSubmit')}
            </Button>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('accounts.reconcile.adjustTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('accounts.reconcile.adjustDescription')}</p>
            <Button
              className="mt-1 w-full"
              disabled={resolutionsBlocked}
              onClick={() => reconcile.mutate('adjustment')}
            >
              {busy && pendingMode === 'adjustment'
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Plus className="h-4 w-4 mr-1" />}
              {t('accounts.reconcile.adjustSubmit')}
            </Button>
          </div>
          {canBackfillOpening && (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('accounts.reconcile.backfillTitle')}</p>
              <p className="text-xs text-muted-foreground">
                {t('accounts.reconcile.backfillDescription', {
                  balance: fmtCur(statement, account.currency),
                })}
              </p>
              <Button
                variant="outline"
                className="mt-1 w-full"
                disabled={busy}
                onClick={() => backfill.mutate()}
              >
                {backfill.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  : <Coins className="h-4 w-4 mr-1" />}
                {t('accounts.reconcile.backfillSubmit')}
              </Button>
            </div>
          )}
        </div>

        {/* Second exit: go read what happened after the statement date. Skipped
            when the backdated warning above already renders it (emphasized). */}
        {sinceDate && !readingIsBackdated && ledgerSinceButton(false)}

        <DialogFooter className="pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
