import { useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Plus } from 'lucide-react';
import { usePortfolio } from '@/hooks/usePortfolio';
import type { PortfolioTxnType, RecurrenceInterval, InvestmentSummary } from '@/types/portfolio';
import { getTxnTypeLabel } from '@/types/portfolio';
import { toast } from 'sonner';
import { DatePicker } from '@/components/shared/DatePicker';
import { parseLocalDateFromYmd, toYmd } from '@/components/shared/dateUtils';

function parsePositive(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface Props {
  investment: InvestmentSummary;
  trigger?: React.ReactNode;
}


export function AddPortfolioTxnDialog({ investment, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useLanguage();
  const { addTransaction } = usePortfolio();

  const RECURRENCE_LABELS: Record<RecurrenceInterval, string> = {
    daily: t('addPortTxn.recurrence.daily'),
    weekly: t('addPortTxn.recurrence.weekly'),
    'bi-weekly': t('addPortTxn.recurrence.biweekly'),
    monthly: t('addPortTxn.recurrence.monthly'),
    quarterly: t('addPortTxn.recurrence.quarterly'),
    yearly: t('addPortTxn.recurrence.yearly'),
  };

  const isUnitBased = ['stock', 'etf', 'crypto', 'metals'].includes(investment.assetClass);
  const isRealEstate = investment.assetClass === 'real_estate';
  const isFixedIncome = ['savings', 'bond'].includes(investment.assetClass);

  // Filter relevant transaction types per asset class
  const allowedTypes: PortfolioTxnType[] = (() => {
    if (isUnitBased) return ['buy', 'sell', 'gift', 'dividend', 'fee', 'tax'];
    if (isRealEstate) return ['buy', 'sell', 'rent_income', 'appreciation', 'fee', 'tax'];
    if (isFixedIncome) return ['buy', 'sell', 'interest', 'fee', 'tax'];
    return ['buy', 'sell', 'fee', 'tax'];
  })();

  const [form, setForm] = useState({
    type: 'buy' as PortfolioTxnType,
    date: new Date().toISOString().slice(0, 10),
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
    type: 'buy', date: new Date().toISOString().slice(0, 10),
    amount: '', units: '', pricePerUnit: '', fees: '', taxes: '', fxRateToEur: '', note: '',
    isRecurring: false, recurrenceInterval: 'monthly', recurrenceEndDate: '',
  });

  const amountInput = parsePositive(form.amount);
  const unitsInput = parsePositive(form.units);
  const priceInput = parsePositive(form.pricePerUnit);
  const isBuySell = ['buy', 'sell'].includes(form.type);
  const isGift = form.type === 'gift';

  let derivedAmount: number | undefined;
  let derivedUnits: number | undefined;
  let derivedPrice: number | undefined;
  if (isBuySell) {
    const provided = Number(amountInput !== undefined) + Number(unitsInput !== undefined) + Number(priceInput !== undefined);
    if (provided >= 2) {
      if (amountInput === undefined && unitsInput !== undefined && priceInput !== undefined) {
        derivedAmount = roundTo(unitsInput * priceInput, 4);
      }
      if (unitsInput === undefined && amountInput !== undefined && priceInput !== undefined) {
        derivedUnits = roundTo(amountInput / priceInput, 8);
      }
      if (priceInput === undefined && amountInput !== undefined && unitsInput !== undefined) {
        derivedPrice = roundTo(amountInput / unitsInput, 6);
      }
    }
  }

  const effectiveAmount = isGift ? 0 : (amountInput ?? derivedAmount);
  const effectiveUnits = unitsInput ?? derivedUnits;
  const effectivePrice = priceInput ?? derivedPrice;

  const buySellIsValid = !isBuySell
    || ((Number(amountInput !== undefined) + Number(unitsInput !== undefined) + Number(priceInput !== undefined)) >= 2
      && effectiveAmount !== undefined
      && effectiveUnits !== undefined
      && effectivePrice !== undefined
      && Math.abs(roundTo(effectiveUnits * effectivePrice, 4) - roundTo(effectiveAmount, 4)) <= 0.0001);

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

    try {
      await addTransaction({
        investmentId: investment.id,
        type: form.type,
        date: form.date,
        amount: isGift ? 0 : effectiveAmount,
        units: effectiveUnits,
        price_per_unit: effectivePrice,
        fees: isGift ? 0 : (form.fees ? parseFloat(form.fees) : undefined),
        taxes: isGift ? 0 : (form.taxes ? parseFloat(form.taxes) : undefined),
        fx_rate_to_eur: form.fxRateToEur ? parseFloat(form.fxRateToEur) : undefined,
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

  const showUnits = isUnitBased && ['buy', 'sell', 'gift'].includes(form.type);
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
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
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
              <div className="space-y-2">
                <Label htmlFor="txn-date">{t('addPortTxn.date')}</Label>
                <DatePicker
                  value={form.date ? parseLocalDateFromYmd(form.date) : undefined}
                  onChange={(date) => setForm(f => ({ ...f, date: date ? toYmd(date) : '' }))}
                  placeholder={t('plannedPage.link.pickDate')}
                />
              </div>

            {showUnits && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="txn-units">{t('addPortTxn.units')}</Label>
                  <Input id="txn-units" type="number" step="0.000001" min="0" placeholder="10" value={form.units} onChange={(e) => setForm(f => ({ ...f, units: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="txn-ppu">{t('addPortTxn.pricePerUnit')}</Label>
                  <Input id="txn-ppu" type="number" step="0.0001" min="0" placeholder="98.50" value={form.pricePerUnit} onChange={(e) => setForm(f => ({ ...f, pricePerUnit: e.target.value }))} />
                </div>
              </>
            )}

            <div className={`space-y-2 ${showUnits ? 'col-span-2' : ''}`}>
              <Label htmlFor="txn-amount">
                {t('addPortTxn.totalAmount', { currency: investment.currency })}
                {isGift
                  ? <span className="text-muted-foreground ml-1 text-xs">= 0</span>
                  : (derivedAmount !== undefined
                    ? <span className="text-muted-foreground ml-1 text-xs">= {derivedAmount.toFixed(4)}</span>
                    : null)}
              </Label>
              <Input
                id="txn-amount"
                type="number"
                step="0.0001"
                min="0"
                placeholder={isGift ? '0.00' : (derivedAmount !== undefined ? derivedAmount.toFixed(4) : '0.00')}
                value={isGift ? '0' : form.amount}
                disabled={isGift}
                onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))}
              />
            </div>

            {isBuySell && !buySellIsValid && (
              <div className="col-span-2 text-xs text-destructive">{t('addPortTxn.error.twoOfThreeRequired')}</div>
            )}

            {showFeesTaxes && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="txn-fees">{t('addPortTxn.fees')}</Label>
                  <Input id="txn-fees" type="number" step="0.01" min="0" placeholder="0.00" value={form.fees} onChange={(e) => setForm(f => ({ ...f, fees: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="txn-taxes">{t('addPortTxn.taxes')}</Label>
                  <Input id="txn-taxes" type="number" step="0.01" min="0" placeholder="0.00" value={form.taxes} onChange={(e) => setForm(f => ({ ...f, taxes: e.target.value }))} />
                </div>
              </>
            )}

            <div className={`space-y-2 ${showFeesTaxes ? 'col-span-2' : ''}`}>
              <Label htmlFor="txn-fx-rate-to-eur">FX rate to EUR (optional)</Label>
              <Input
                id="txn-fx-rate-to-eur"
                type="number"
                step="0.0000000001"
                min="0"
                placeholder="1.0000000000"
                value={form.fxRateToEur}
                onChange={(e) => setForm(f => ({ ...f, fxRateToEur: e.target.value }))}
              />
            </div>
          </div>

          {showRecurring && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="txn-recurring" className="text-sm">{t('addPortTxn.recurring')}</Label>
                <Switch id="txn-recurring" checked={form.isRecurring} onCheckedChange={(v) => setForm(f => ({ ...f, isRecurring: v }))} />
              </div>
              {form.isRecurring && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('addPortTxn.interval')}</Label>
                    <Select value={form.recurrenceInterval} onValueChange={(v) => setForm(f => ({ ...f, recurrenceInterval: v as RecurrenceInterval }))}>
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
                      onChange={(date) => setForm(f => ({ ...f, recurrenceEndDate: date ? toYmd(date) : '' }))}
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
            <Label htmlFor="txn-note">{t('addPortTxn.note')}</Label>
            <Textarea id="txn-note" placeholder={t('addPortTxn.note')} rows={2} value={form.note} onChange={(e) => setForm(f => ({ ...f, note: e.target.value }))} maxLength={300} />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('addPortTxn.cancel')}</Button>
            <Button type="submit">{t('addPortTxn.record')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
