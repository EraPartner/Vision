import { useState } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { deriveUnitMath, parsePositive } from '@/lib/portfolioUnitMath';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { toYmd } from '@/components/shared/dateUtils';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useAccounts } from '@/hooks/useAccounts';
import { isUnitBased } from '@/utils/assetClass';
import { toast } from 'sonner';
import type { InvestmentSummary, PortfolioTxnType, RecurrenceInterval } from '@/types/portfolio';
import type { PortfolioTransaction, PortfolioTransactionCreate } from '@/types/api';
import { getTxnTypeLabel } from '@/types/portfolio';
import { PortfolioTxnFormFields } from './PortfolioTxnFormFields';


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
  const { updateTransaction, isUpdatingTransaction } = usePortfolio();
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
          <PortfolioTxnFormFields
            idPrefix="edit-txn"
            form={form}
            setForm={setForm}
            currency={investment.currency}
            t={t}
            typeField={(
              <div className="space-y-2">
                <Label>{t('addPortTxn.type')}</Label>
                <Input value={getTxnTypeLabel(t, transaction.type)} disabled />
              </div>
            )}
            accounts={accountsData?.items ?? []}
            showUnits={showUnits}
            showFeesTaxes={showFeesTaxes}
            showRecurring={showRecurring}
            derivedAmount={derivedAmount}
            isBuySell={isBuySell}
            buySellIsValid={buySellIsValid}
            isGift={isGift}
            lockAmountWhenGift={false}
            withPlaceholders={false}
          />

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={isUpdatingTransaction}>
              {isUpdatingTransaction && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
