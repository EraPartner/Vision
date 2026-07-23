import { useState } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { deriveUnitMath, parsePositive } from '@/lib/portfolioUnitMath';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Loader2 } from 'lucide-react';
import { isUnitBased, isFixedIncome, isRealEstate } from '@/utils/assetClass';
import { usePortfolio } from '@/hooks/usePortfolio';
import type { PortfolioTxnType, RecurrenceInterval, InvestmentSummary } from '@/types/portfolio';
import { getTxnTypeLabel } from '@/types/portfolio';
import { toast } from 'sonner';
import { toYmd } from '@/components/shared/dateUtils';
import { PortfolioTxnFormFields } from './PortfolioTxnFormFields';

interface Props {
  investment: InvestmentSummary;
  trigger?: React.ReactNode;
}


export function AddPortfolioTxnDialog({ investment, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useLanguage();
  const { addTransaction, isAddingTransaction } = usePortfolio();

  const unitBased = isUnitBased(investment.assetClass);
  const realEstate = isRealEstate(investment.assetClass);
  const fixedIncome = isFixedIncome(investment.assetClass);

  // Filter relevant transaction types per asset class
  const allowedTypes: PortfolioTxnType[] = (() => {
    if (unitBased) return ['buy', 'sell', 'gift', 'dividend', 'fee', 'tax'];
    if (realEstate) return ['buy', 'sell', 'rent_income', 'appreciation', 'fee', 'tax'];
    if (fixedIncome) return ['buy', 'sell', 'interest', 'fee', 'tax'];
    return ['buy', 'sell', 'fee', 'tax'];
  })();

  const [form, setForm] = useState({
    type: 'buy' as PortfolioTxnType,
    date: toYmd(new Date()),
    amount: '',
    units: '',
    pricePerUnit: '',
    fees: '',
    taxes: '',
    fxRateToEur: '',
    note: '',
    isRecurring: false,
    recurrenceInterval: 'monthly' as RecurrenceInterval,
    recurrenceEndDate: '',
  });

  const reset = () => setForm({
    type: 'buy', date: toYmd(new Date()),
    amount: '', units: '', pricePerUnit: '', fees: '', taxes: '', fxRateToEur: '', note: '',
    isRecurring: false, recurrenceInterval: 'monthly', recurrenceEndDate: '',
  });

  const amountInput = parsePositive(form.amount);
  const unitsInput = parsePositive(form.units);
  const priceInput = parsePositive(form.pricePerUnit);
  const isBuySell = ['buy', 'sell'].includes(form.type);
  const isGift = form.type === 'gift';

  const unitMath = deriveUnitMath({ amount: amountInput, units: unitsInput, price: priceInput, derive: isBuySell });
  const { derivedAmount } = unitMath;

  const effectiveAmount = isGift ? 0 : unitMath.effectiveAmount;
  const effectiveUnits = unitMath.effectiveUnits;
  const effectivePrice = unitMath.effectivePrice;

  const buySellIsValid = !isBuySell || unitMath.isConsistent;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBuySell && !buySellIsValid) {
      toast.error(t('addPortTxn.error.twoOfThreeRequired'));
      return;
    }

    if (!isGift && (effectiveAmount === undefined || isNaN(effectiveAmount))) {
      toast.error(t('addPortTxn.error.amountRequired'));
      return;
    }

    if (isGift && effectiveUnits === undefined) {
      toast.error(t('addPortTxn.error.unitsRequired'));
      return;
    }

    // NaN fallback, not the default 0 — garbage in these fields must block the
    // submit instead of silently posting €0 fees/taxes or fx_rate_to_eur = 0.
    const feesValue = form.fees ? parseDecimal(form.fees, NaN) : undefined;
    const taxesValue = form.taxes ? parseDecimal(form.taxes, NaN) : undefined;
    const fxRateValue = form.fxRateToEur ? parseDecimal(form.fxRateToEur, NaN) : undefined;
    if (
      (feesValue !== undefined && (!Number.isFinite(feesValue) || feesValue < 0)) ||
      (taxesValue !== undefined && (!Number.isFinite(taxesValue) || taxesValue < 0)) ||
      (fxRateValue !== undefined && (!Number.isFinite(fxRateValue) || fxRateValue <= 0))
    ) {
      toast.error(t('addPortTxn.error.invalidNumber'));
      return;
    }

    try {
      await addTransaction({
        investmentId: investment.id,
        type: form.type,
        date: form.date,
        amount: isGift ? 0 : effectiveAmount,
        units: effectiveUnits,
        price_per_unit: effectivePrice,
        fees: isGift ? 0 : feesValue,
        taxes: isGift ? 0 : taxesValue,
        fx_rate_to_eur: fxRateValue,
        currency: investment.currency,
        note: form.note.trim() || undefined,
        is_recurring: form.isRecurring,
        recurrence_interval: form.isRecurring ? form.recurrenceInterval : undefined,
        recurrence_end_date: form.isRecurring && form.recurrenceEndDate ? form.recurrenceEndDate : undefined,
      });
      toast.success(t('addPortTxn.toast.recorded', { type: getTxnTypeLabel(t, form.type), name: investment.name }));
      reset();
      setOpen(false);
    } catch {
      // error handled by hook
    }
  };

  const showUnits = unitBased && ['buy', 'sell', 'gift'].includes(form.type);
  const showFeesTaxes = ['buy', 'sell', 'dividend'].includes(form.type);
  const showRecurring = ['buy', 'sell', 'dividend', 'interest', 'rent_income'].includes(form.type);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="gap-1.5">
            <Plus className="h-4 w-4" /> {t('form.addTransaction.title')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('addPortTxn.title', { symbol: investment.symbol || investment.name })}</DialogTitle>
          <DialogDescription className="sr-only">{t('addPortTxn.title', { symbol: investment.symbol || investment.name })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <PortfolioTxnFormFields
            idPrefix="txn"
            form={form}
            setForm={setForm}
            currency={investment.currency}
            t={t}
            typeField={(
              <div className="space-y-2">
                <Label>{t('addPortTxn.type')}</Label>
                <Select value={form.type} onValueChange={(v) => setForm(f => ({ ...f, type: v as PortfolioTxnType }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {allowedTypes.map(txnType => (
                      <SelectItem key={txnType} value={txnType}>{getTxnTypeLabel(t, txnType)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            showUnits={showUnits}
            showFeesTaxes={showFeesTaxes}
            showRecurring={showRecurring}
            derivedAmount={derivedAmount}
            isBuySell={isBuySell}
            buySellIsValid={buySellIsValid}
            isGift={isGift}
            lockAmountWhenGift
            withPlaceholders
          />

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('addPortTxn.cancel')}</Button>
            <Button type="submit" disabled={isAddingTransaction}>
              {isAddingTransaction && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('addPortTxn.record')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
