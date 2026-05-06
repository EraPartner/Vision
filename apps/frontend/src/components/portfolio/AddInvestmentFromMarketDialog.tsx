import { useState } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus } from 'lucide-react';
import { isUnitBased } from '@/utils/assetClass';
import { usePortfolio } from '@/hooks/usePortfolio';
import type { PortfolioTxnType, RecurrenceInterval, InvestmentSummary } from '@/types/portfolio';
import { TXN_TYPE_LABELS } from '@/types/portfolio';
import { toast } from 'sonner';
import { DatePicker } from '@/components/shared/DatePicker';
import { formatDateWithAppSettings, parseLocalDateFromYmd, toYmd } from '@/components/shared/dateUtils';
import { useAppSettings } from '@/contexts/AppSettingsContext';

interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  exchange: string;
  type: string;
}

interface Props {
  quote: Quote;
  existingInvestment?: InvestmentSummary;
}


export function AddInvestmentFromMarketDialog({ quote, existingInvestment }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'choose' | 'new' | 'transaction'>('choose');
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const { addInvestment, addTransaction } = usePortfolio();

  const todayYmd = toYmd(new Date());
  const todayLabel = formatDateWithAppSettings(new Date(), appSettings.dateFormat);

  // Determine asset class from quote type
  const getAssetClass = (type: string) => {
    if (type.toLowerCase().includes('etf')) return 'etf';
    if (['stock', 'equity'].some(t => type.toLowerCase().includes(t))) return 'stock';
    if (type.toLowerCase().includes('crypto')) return 'crypto';
    return 'stock'; // default
  };

  const assetClass = getAssetClass(quote.type);
  const unitBased = isUnitBased(assetClass);

  const [newInvestmentForm, setNewInvestmentForm] = useState({
    name: quote.name,
    symbol: quote.symbol,
    currency: quote.currency ?? 'EUR',
    currentPrice: quote.price.toString(),
    notes: t('addInvFromMarket.notesDefault', { date: todayLabel }),
  });

  const [transactionForm, setTransactionForm] = useState({
    type: 'buy' as PortfolioTxnType,
    date: todayYmd,
    amount: '',
    units: '',
    pricePerUnit: quote.price.toString(),
    fees: '',
    taxes: '',
    note: '',
    isRecurring: false,
    recurrenceInterval: 'monthly' as RecurrenceInterval,
    recurrenceEndDate: '',
  });

  const reset = () => {
    setStep('choose');
    setNewInvestmentForm({
      name: quote.name,
      symbol: quote.symbol,
      currency: quote.currency ?? 'EUR',
      currentPrice: quote.price.toString(),
      notes: t('addInvFromMarket.notesDefault', { date: todayLabel }),
    });
    setTransactionForm({
      type: 'buy',
      date: todayYmd,
      amount: '',
      units: '',
      pricePerUnit: quote.price.toString(),
      fees: '',
      taxes: '',
      note: '',
      isRecurring: false,
      recurrenceInterval: 'monthly',
      recurrenceEndDate: '',
    });
  };

  const handleCreateInvestment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInvestmentForm.name.trim()) return;

    try {
      await addInvestment({
        name: newInvestmentForm.name.trim(),
        symbol: newInvestmentForm.symbol.trim(),
        asset_class: assetClass,
        currency: newInvestmentForm.currency,
        current_price: parseDecimal(newInvestmentForm.currentPrice),
        notes: newInvestmentForm.notes.trim() || undefined,
        price_provider: 'yahoo',
        price_provider_id: quote.symbol,
      });
      toast.success(t('addInv.toast.added', { assetClass, name: quote.symbol }));
      reset();
      setOpen(false);
    } catch {
      // error handled by hook
    }
  };

  const computedAmount = transactionForm.units && transactionForm.pricePerUnit
    ? (parseDecimal(transactionForm.units) * parseDecimal(transactionForm.pricePerUnit)).toFixed(2)
    : '';

  const handleAddTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!existingInvestment) return;
    
    const amount = parseDecimal(transactionForm.amount || computedAmount, NaN);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('addPortTxn.error.amountRequired'));
      return; 
    }

    try {
      await addTransaction({
        investmentId: existingInvestment.id,
        type: transactionForm.type,
        date: transactionForm.date,
        amount,
        units: transactionForm.units ? parseDecimal(transactionForm.units) : undefined,
        price_per_unit: transactionForm.pricePerUnit ? parseDecimal(transactionForm.pricePerUnit) : undefined,
        fees: transactionForm.fees ? parseDecimal(transactionForm.fees) : undefined,
        taxes: transactionForm.taxes ? parseDecimal(transactionForm.taxes) : undefined,
        currency: existingInvestment.currency,
        note: transactionForm.note.trim() || undefined,
        is_recurring: transactionForm.isRecurring,
        recurrence_interval: transactionForm.isRecurring ? transactionForm.recurrenceInterval : undefined,
        recurrence_end_date: transactionForm.isRecurring && transactionForm.recurrenceEndDate ? transactionForm.recurrenceEndDate : undefined,
      });
      toast.success(t('addPortTxn.toast.recorded', { type: TXN_TYPE_LABELS[transactionForm.type], name: quote.symbol }));
      reset();
      setOpen(false);
    } catch {
      // error handled by hook
    }
  };

  const allowedTypes: PortfolioTxnType[] = unitBased
    ? ['buy', 'sell', 'dividend', 'fee', 'tax']
    : ['buy', 'sell', 'fee', 'tax'];

  const showUnits = unitBased && ['buy', 'sell'].includes(transactionForm.type);
  const showFeesTaxes = ['buy', 'sell'].includes(transactionForm.type);
  const _showRecurring = ['buy', 'sell', 'dividend', 'interest', 'rent_income'].includes(transactionForm.type);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t(existingInvestment ? 'form.addTransaction.title' : 'portfolio.addInvestment')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'choose' ? t('addInvFromMarket.title.add', { symbol: quote.symbol }) :
             step === 'new' ? t('addInvFromMarket.title.create') :
             t('addInvFromMarket.title.transaction')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('addInvFromMarket.title.add', { symbol: quote.symbol })}</DialogDescription>
        </DialogHeader>

        {step === 'choose' && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              {t('addInvFromMarket.prompt', { symbol: quote.symbol })}
            </div>
            <div className="space-y-2">
              {existingInvestment && (
                <Button
                  variant="outline"
                  className="w-full justify-start h-auto p-4"
                  onClick={() => setStep('transaction')}
                >
                  <div className="text-left">
                    <div className="font-medium">{t('form.addTransaction.title')}</div>
                    <div className="text-sm text-muted-foreground">
                      {t('addInvFromMarket.option.addTxnDesc')}
                    </div>
                  </div>
                </Button>
              )}
              <Button
                variant="outline"
                className="w-full justify-start h-auto p-4"
                onClick={() => setStep('new')}
              >
                <div className="text-left">
                  <div className="font-medium">{t('addInvFromMarket.option.createNew')}</div>
                  <div className="text-sm text-muted-foreground">
                    {existingInvestment ? t('addInvFromMarket.option.createDescExisting') : t('addInvFromMarket.option.createDescNew')}
                  </div>
                </div>
              </Button>
            </div>
          </div>
        )}

        {step === 'new' && (
          <form onSubmit={handleCreateInvestment} className="space-y-4">
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="new-name">{t('addInv.label.name')}</Label>
                <Input 
                  id="new-name" 
                  value={newInvestmentForm.name} 
                  onChange={(e) => setNewInvestmentForm(f => ({ ...f, name: e.target.value }))}
                  maxLength={100} 
                  required 
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="new-symbol">{t('addInv.label.ticker')}</Label>
                  <Input 
                    id="new-symbol" 
                    value={newInvestmentForm.symbol} 
                    onChange={(e) => setNewInvestmentForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                    maxLength={20} 
                    className="font-mono"
                    readOnly
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-currency">{t('addInv.label.currency')}</Label>
                  <Select 
                    value={newInvestmentForm.currency} 
                    onValueChange={(v) => setNewInvestmentForm(f => ({ ...f, currency: v }))}
                  >
                    <SelectTrigger id="new-currency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['EUR', 'USD', 'GBP', 'CHF'].map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-price">{t('addInv.label.currentPrice')}</Label>
                <Input 
                  id="new-price" 
                  type="number" 
                  step="0.0001" 
                  min="0" 
                  value={newInvestmentForm.currentPrice} 
                  onChange={(e) => setNewInvestmentForm(f => ({ ...f, currentPrice: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-notes">{t('addInv.label.notes')}</Label>
                <Textarea 
                  id="new-notes" 
                  rows={2} 
                  value={newInvestmentForm.notes} 
                  onChange={(e) => setNewInvestmentForm(f => ({ ...f, notes: e.target.value }))}
                  maxLength={500} 
                />
              </div>
            </div>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('choose')}>
                {t('addInv.back')}
              </Button>
              <Button type="submit">{t('addInv.create')}</Button>
            </DialogFooter>
          </form>
        )}

        {step === 'transaction' && existingInvestment && (
          <form onSubmit={handleAddTransaction} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('addPortTxn.type')}</Label>
                <Select 
                  value={transactionForm.type} 
                  onValueChange={(v) => setTransactionForm(f => ({ ...f, type: v as PortfolioTxnType }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {allowedTypes.map(t => (
                      <SelectItem key={t} value={t}>{TXN_TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="txn-date">{t('addPortTxn.date')}</Label>
                <DatePicker
                  value={transactionForm.date ? parseLocalDateFromYmd(transactionForm.date) : undefined}
                  onChange={(date) => setTransactionForm(f => ({ ...f, date: date ? toYmd(date) : '' }))}
                  placeholder={t('plannedPage.link.pickDate')}
                />
              </div>

              {showUnits && (
                <>
                    <div className="space-y-2">
                      <Label htmlFor="txn-units">{t('addPortTxn.units')}</Label>
                      <Input 
                        id="txn-units" 
                        type="number" 
                        step="0.000001" 
                        min="0" 
                        placeholder="10" 
                        value={transactionForm.units} 
                        onChange={(e) => setTransactionForm(f => ({ ...f, units: e.target.value }))} 
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="txn-ppu">{t('addPortTxn.pricePerUnit')}</Label>
                      <Input 
                        id="txn-ppu" 
                        type="number" 
                        step="0.0001" 
                        min="0" 
                        placeholder={quote.price.toString()} 
                        value={transactionForm.pricePerUnit} 
                        onChange={(e) => setTransactionForm(f => ({ ...f, pricePerUnit: e.target.value }))} 
                      />
                    </div>
                  </>
                )}

              <div className={`space-y-2 ${showUnits ? 'col-span-2' : ''}`}>
                <Label htmlFor="txn-amount">
                  {t('addPortTxn.totalAmount', { currency: existingInvestment.currency })}
                  {computedAmount && <span className="text-muted-foreground ml-1 text-xs">= {computedAmount}</span>}
                </Label>
                <Input 
                  id="txn-amount" 
                  type="number" 
                  step="0.01" 
                  min="0" 
                  placeholder={computedAmount || '0.00'} 
                  value={transactionForm.amount} 
                  onChange={(e) => setTransactionForm(f => ({ ...f, amount: e.target.value }))} 
                />
              </div>

              {showFeesTaxes && (
                <>
                    <div className="space-y-2">
                    <Label htmlFor="txn-fees">{t('addPortTxn.fees')}</Label>
                    <Input 
                      id="txn-fees" 
                      type="number" 
                      step="0.01" 
                      min="0" 
                      placeholder="0.00" 
                      value={transactionForm.fees} 
                      onChange={(e) => setTransactionForm(f => ({ ...f, fees: e.target.value }))} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="txn-taxes">{t('addPortTxn.taxes')}</Label>
                    <Input 
                      id="txn-taxes" 
                      type="number" 
                      step="0.01" 
                      min="0" 
                      placeholder="0.00" 
                      value={transactionForm.taxes} 
                      onChange={(e) => setTransactionForm(f => ({ ...f, taxes: e.target.value }))} 
                    />
                  </div>
                </>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="txn-note">{t('addPortTxn.note')}</Label>
              <Textarea 
                id="txn-note" 
                placeholder={t('addPortTxn.note')} 
                rows={2} 
                value={transactionForm.note} 
                onChange={(e) => setTransactionForm(f => ({ ...f, note: e.target.value }))} 
                maxLength={300} 
              />
            </div>

            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('choose')}>
                {t('addInv.back')}
              </Button>
              <Button type="submit">{t('addPortTxn.record')}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
