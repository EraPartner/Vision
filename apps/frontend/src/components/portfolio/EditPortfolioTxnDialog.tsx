import { useMemo, useState } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { deriveUnitMath } from '@/lib/portfolioUnitMath';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker } from '@/components/shared/DatePicker';
import { parseLocalDateFromYmd, toYmd } from '@/components/shared/dateUtils';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useAccounts } from '@/hooks/useAccounts';
import { isPerAccountHoldingsEnabled } from '@/lib/env';
import { isUnitBased } from '@/utils/assetClass';
import { toast } from 'sonner';
import type { InvestmentSummary, PortfolioTxnType, RecurrenceInterval } from '@/types/portfolio';
import type { PortfolioTransaction, PortfolioTransactionCreate } from '@/types/api';
import { getTxnTypeLabel } from '@/types/portfolio';


function parsePositive(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = parseDecimal(value, NaN);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseNonNegative(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = parseDecimal(value, NaN);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function normalizeYmdInput(value?: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  const datePart = trimmed.includes('T')
    ? trimmed.split('T')[0]
    : (trimmed.includes(' ') ? trimmed.split(' ')[0] : trimmed);

  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return datePart;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return '';
  return toYmd(parsed);
}

interface Props {
  investment: InvestmentSummary;
  transaction: PortfolioTransaction;
  trigger?: React.ReactNode;
}

export function EditPortfolioTxnDialog({ investment, transaction, trigger }: Props) {
  const { t } = useLanguage();
  const { updateTransaction } = usePortfolio();
  const [open, setOpen] = useState(false);

  const unitBased = isUnitBased(investment.assetClass);

  // Per-account positioning (ADR-091): a lot's owning account is editable here so
  // it no longer requires a raw API call to move a single lot between accounts.
  const { data: accountsData } = useAccounts({ active: 'true' });

  const initialForm = () => ({
    date: normalizeYmdInput(transaction.date),
    amount: String(transaction.amount ?? ''),
    units: transaction.units !== undefined ? String(transaction.units) : '',
    pricePerUnit: transaction.price_per_unit !== undefined ? String(transaction.price_per_unit) : '',
    fees: transaction.fees !== undefined ? String(transaction.fees) : '',
    taxes: transaction.taxes !== undefined ? String(transaction.taxes) : '',
    fxRateToEur: transaction.fx_rate_to_eur !== undefined ? String(transaction.fx_rate_to_eur) : '',
    note: transaction.note || '',
    accountId: transaction.account_id != null ? String(transaction.account_id) : '',
    isRecurring: Boolean(transaction.is_recurring),
    recurrenceInterval: (transaction.recurrence_interval || 'monthly') as RecurrenceInterval,
    recurrenceEndDate: normalizeYmdInput(transaction.recurrence_end_date),
  });

  const [form, setForm] = useState(initialForm);

  const reset = () => setForm(initialForm());

  const isBuySell = transaction.type === 'buy' || transaction.type === 'sell';
  const isGift = transaction.type === 'gift';
  const isUnitMathTxn = isBuySell || isGift;

  const amountInput = parseNonNegative(form.amount);
  const unitsInput = parsePositive(form.units);
  const priceInput = parsePositive(form.pricePerUnit);

  const unitMath = deriveUnitMath({ amount: amountInput, units: unitsInput, price: priceInput, derive: isUnitMathTxn });
  const { derivedAmount } = unitMath;

  const effectiveAmount = unitMath.effectiveAmount;
  const effectiveUnits = unitMath.effectiveUnits;
  const effectivePrice = unitMath.effectivePrice;

  const buySellIsValid = !isBuySell || unitMath.isConsistent;

  const showUnits = unitBased && ['buy', 'sell', 'gift'].includes(transaction.type);
  const showFeesTaxes = ['buy', 'sell', 'dividend'].includes(transaction.type);
  const showRecurring = ['buy', 'sell', 'dividend', 'interest', 'rent_income'].includes(transaction.type);

  const RECURRENCE_LABELS: Record<RecurrenceInterval, string> = useMemo(() => ({
    daily: t('addPortTxn.recurrence.daily'),
    weekly: t('addPortTxn.recurrence.weekly'),
    'bi-weekly': t('addPortTxn.recurrence.biweekly'),
    monthly: t('addPortTxn.recurrence.monthly'),
    quarterly: t('addPortTxn.recurrence.quarterly'),
    yearly: t('addPortTxn.recurrence.yearly'),
  }), [t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isBuySell && !buySellIsValid) {
      toast.error(t('addPortTxn.error.twoOfThreeRequired'));
      return;
    }
    if (!isGift && (effectiveAmount === undefined || isNaN(effectiveAmount) || effectiveAmount <= 0)) {
      toast.error(t('addPortTxn.error.amountRequired'));
      return;
    }
    if (isGift && effectiveUnits === undefined) {
      toast.error(t('addPortTxn.error.unitsRequired'));
      return;
    }
    if (!form.date) {
      toast.error(t('plannedPage.link.pickDate'));
      return;
    }

    // Same guard as the Add dialog: NaN fallback so garbage can't silently
    // become €0, and an FX rate of 0 (min="0" permits it) must not reach the
    // backend's "must be positive" check as a raw 400.
    const feesValue = form.fees ? parseDecimal(form.fees, NaN) : 0;
    const taxesValue = form.taxes ? parseDecimal(form.taxes, NaN) : 0;
    const fxRateValue = form.fxRateToEur ? parseDecimal(form.fxRateToEur, NaN) : null;
    if (
      !Number.isFinite(feesValue) || feesValue < 0 ||
      !Number.isFinite(taxesValue) || taxesValue < 0 ||
      (fxRateValue !== null && (!Number.isFinite(fxRateValue) || fxRateValue <= 0))
    ) {
      toast.error(t('addPortTxn.error.invalidNumber'));
      return;
    }

    try {
      // account_id: a number reassigns the lot, explicit null clears it back to
      // unassigned (the PATCH endpoint maps null → SQL NULL, undefined → unchanged).
      await updateTransaction(transaction.id, {
        date: form.date,
        amount: effectiveAmount,
        units: effectiveUnits,
        price_per_unit: effectivePrice,
        // Cleared fields must be SENT, not dropped: undefined keys vanish from
        // the JSON body and the backend merge keeps the old value — "delete the
        // €7.50 fee → Save → success" left the fee in the DB (and the FX/note
        // likewise). Cleared money fields are 0; cleared note/FX are explicit
        // null, same semantics as account_id below.
        fees: isGift ? 0 : feesValue,
        taxes: isGift ? 0 : taxesValue,
        fx_rate_to_eur: fxRateValue,
        note: form.note.trim() || null,
        account_id: form.accountId ? Number(form.accountId) : null,
        is_recurring: form.isRecurring,
        recurrence_interval: form.isRecurring ? form.recurrenceInterval : undefined,
        recurrence_end_date: form.isRecurring && form.recurrenceEndDate ? form.recurrenceEndDate : undefined,
      } as Partial<PortfolioTransactionCreate>);
      toast.success(t('txnEdit.toast.updated', { type: getTxnTypeLabel(t, transaction.type as PortfolioTxnType) }));
      setOpen(false);
    } catch {
      // handled in hook
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? <Button variant="outline">{t('common.edit')}</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('txnEdit.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('txnEdit.title')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('addPortTxn.type')}</Label>
              <Input value={getTxnTypeLabel(t, transaction.type)} disabled />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-txn-date">{t('addPortTxn.date')}</Label>
              <DatePicker
                value={form.date ? parseLocalDateFromYmd(form.date) : undefined}
                onChange={(date) => setForm((f) => ({ ...f, date: date ? toYmd(date) : '' }))}
                placeholder={t('plannedPage.link.pickDate')}
              />
            </div>

            {isPerAccountHoldingsEnabled && (
              <div className="space-y-2 col-span-2">
                <Label>{t('nav.accounts')}</Label>
                <Select
                  value={form.accountId || 'none'}
                  onValueChange={(v) => setForm((f) => ({ ...f, accountId: v === 'none' ? '' : v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('accounts.unassigned')}</SelectItem>
                    {(accountsData?.items ?? []).map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>{a.display_name || a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {showUnits && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-txn-units">{t('addPortTxn.units')}</Label>
                  <Input
                    id="edit-txn-units"
                    type="number"
                    step="0.000001"
                    min="0"
                    value={form.units}
                    onChange={(e) => setForm((f) => ({ ...f, units: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-txn-ppu">{t('addPortTxn.pricePerUnit')}</Label>
                  <Input
                    id="edit-txn-ppu"
                    type="number"
                    step="0.0001"
                    min="0"
                    value={form.pricePerUnit}
                    onChange={(e) => setForm((f) => ({ ...f, pricePerUnit: e.target.value }))}
                  />
                </div>
              </>
            )}

            <div className={`space-y-2 ${showUnits ? 'col-span-2' : ''}`}>
              <Label htmlFor="edit-txn-amount">
                {t('addPortTxn.totalAmount', { currency: investment.currency })}
                {derivedAmount !== undefined
                  ? <span className="text-muted-foreground ml-1 text-xs">= {derivedAmount.toFixed(4)}</span>
                  : null}
              </Label>
              <Input
                id="edit-txn-amount"
                type="number"
                step="0.0001"
                min="0"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>

            {isBuySell && !buySellIsValid && (
              <div className="col-span-2 text-xs text-destructive">{t('addPortTxn.error.twoOfThreeRequired')}</div>
            )}

            {showFeesTaxes && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-txn-fees">{t('addPortTxn.fees')}</Label>
                  <Input
                    id="edit-txn-fees"
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.fees}
                    onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-txn-taxes">{t('addPortTxn.taxes')}</Label>
                  <Input
                    id="edit-txn-taxes"
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.taxes}
                    onChange={(e) => setForm((f) => ({ ...f, taxes: e.target.value }))}
                  />
                </div>
              </>
            )}

            <div className={`space-y-2 ${showFeesTaxes ? 'col-span-2' : ''}`}>
              <Label htmlFor="edit-txn-fx-rate-to-eur">FX rate to EUR (optional)</Label>
              <Input
                id="edit-txn-fx-rate-to-eur"
                type="number"
                step="0.0000000001"
                min="0"
                value={form.fxRateToEur}
                onChange={(e) => setForm((f) => ({ ...f, fxRateToEur: e.target.value }))}
              />
            </div>
          </div>

          {showRecurring && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-txn-recurring" className="text-sm">{t('addPortTxn.recurring')}</Label>
                <Switch
                  id="edit-txn-recurring"
                  checked={form.isRecurring}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, isRecurring: v }))}
                />
              </div>
              {form.isRecurring && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('addPortTxn.interval')}</Label>
                    <Select
                      value={form.recurrenceInterval}
                      onValueChange={(v) => setForm((f) => ({ ...f, recurrenceInterval: v as RecurrenceInterval }))}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(RECURRENCE_LABELS).map(([k, l]) => (
                          <SelectItem key={k} value={k}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('addPortTxn.endDate')}</Label>
                    <DatePicker
                      value={form.recurrenceEndDate ? parseLocalDateFromYmd(form.recurrenceEndDate) : undefined}
                      onChange={(date) => setForm((f) => ({ ...f, recurrenceEndDate: date ? toYmd(date) : '' }))}
                      placeholder={t('plannedPage.link.pickDate')}
                      allowClear
                      clearLabel={t('common.clear')}
                      buttonClassName="h-8 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="edit-txn-note">{t('addPortTxn.note')}</Label>
            <Textarea
              id="edit-txn-note"
              rows={2}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              maxLength={300}
            />
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
