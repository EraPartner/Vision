import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Plus, TrendingUp } from 'lucide-react';
import { usePortfolio } from '@/hooks/usePortfolio';
import type { PortfolioTxnType, RecurrenceInterval, InvestmentSummary } from '@/types/portfolio';
import { TXN_TYPE_LABELS } from '@/types/portfolio';
import { toast } from 'sonner';

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

const RECURRENCE_LABELS: Record<RecurrenceInterval, string> = {
  daily: 'Daily', weekly: 'Weekly', 'bi-weekly': 'Bi-weekly',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
};

export function AddInvestmentFromMarketDialog({ quote, existingInvestment }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'choose' | 'new' | 'transaction'>('choose');
  const { addInvestment, addTransaction } = usePortfolio();

  // Determine asset class from quote type
  const getAssetClass = (type: string) => {
    if (type.toLowerCase().includes('etf')) return 'etf';
    if (['stock', 'equity'].some(t => type.toLowerCase().includes(t))) return 'stock';
    if (type.toLowerCase().includes('crypto')) return 'crypto';
    return 'stock'; // default
  };

  const assetClass = getAssetClass(quote.type);
  const isUnitBased = ['stock', 'etf', 'crypto'].includes(assetClass);

  const [newInvestmentForm, setNewInvestmentForm] = useState({
    name: quote.name,
    symbol: quote.symbol,
    currency: quote.currency === 'USD' ? 'USD' : 'EUR',
    currentPrice: quote.price.toString(),
    notes: `Added from market lookup on ${new Date().toLocaleDateString()}`,
  });

  const [transactionForm, setTransactionForm] = useState({
    type: 'buy' as PortfolioTxnType,
    date: new Date().toISOString().slice(0, 10),
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
      currency: quote.currency === 'USD' ? 'USD' : 'EUR',
      currentPrice: quote.price.toString(),
      notes: `Added from market lookup on ${new Date().toLocaleDateString()}`,
    });
    setTransactionForm({
      type: 'buy',
      date: new Date().toISOString().slice(0, 10),
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
        current_price: parseFloat(newInvestmentForm.currentPrice),
        notes: newInvestmentForm.notes.trim() || undefined,
        price_provider: 'yahoo',
        price_provider_id: quote.symbol,
      });
      toast.success(`${quote.symbol} added to portfolio`);
      reset();
      setOpen(false);
    } catch {
      // error handled by hook
    }
  };

  const computedAmount = transactionForm.units && transactionForm.pricePerUnit
    ? (parseFloat(transactionForm.units) * parseFloat(transactionForm.pricePerUnit)).toFixed(2)
    : '';

  const handleAddTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!existingInvestment) return;
    
    const amount = parseFloat(transactionForm.amount || computedAmount);
    if (!amount || isNaN(amount)) { 
      toast.error('Amount is required'); 
      return; 
    }

    try {
      await addTransaction({
        investmentId: existingInvestment.id,
        type: transactionForm.type,
        date: transactionForm.date,
        amount,
        units: transactionForm.units ? parseFloat(transactionForm.units) : undefined,
        price_per_unit: transactionForm.pricePerUnit ? parseFloat(transactionForm.pricePerUnit) : undefined,
        fees: transactionForm.fees ? parseFloat(transactionForm.fees) : undefined,
        taxes: transactionForm.taxes ? parseFloat(transactionForm.taxes) : undefined,
        currency: existingInvestment.currency,
        note: transactionForm.note.trim() || undefined,
        is_recurring: transactionForm.isRecurring,
        recurrence_interval: transactionForm.isRecurring ? transactionForm.recurrenceInterval : undefined,
        recurrence_end_date: transactionForm.isRecurring && transactionForm.recurrenceEndDate ? transactionForm.recurrenceEndDate : undefined,
      });
      toast.success(`${TXN_TYPE_LABELS[transactionForm.type]} recorded for ${quote.symbol}`);
      reset();
      setOpen(false);
    } catch {
      // error handled by hook
    }
  };

  const allowedTypes: PortfolioTxnType[] = isUnitBased 
    ? ['buy', 'sell', 'dividend', 'fee', 'tax'] 
    : ['buy', 'sell', 'fee', 'tax'];

  const showUnits = isUnitBased && ['buy', 'sell'].includes(transactionForm.type);
  const showFeesTaxes = ['buy', 'sell'].includes(transactionForm.type);
  const showRecurring = ['buy', 'sell', 'dividend', 'interest', 'rent_income'].includes(transactionForm.type);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" />
          {existingInvestment ? 'Add Transaction' : 'Add to Portfolio'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'choose' ? `Add ${quote.symbol}` : 
             step === 'new' ? `Create Investment` : 
             `Add Transaction`}
          </DialogTitle>
        </DialogHeader>

        {step === 'choose' && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              What would you like to do with <strong>{quote.symbol}</strong>?
            </div>
            <div className="space-y-2">
              {existingInvestment && (
                <Button
                  variant="outline"
                  className="w-full justify-start h-auto p-4"
                  onClick={() => setStep('transaction')}
                >
                  <div className="text-left">
                    <div className="font-medium">Add Transaction</div>
                    <div className="text-sm text-muted-foreground">
                      Record a buy/sell for existing investment
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
                  <div className="font-medium">Create New Investment</div>
                  <div className="text-sm text-muted-foreground">
                    {existingInvestment ? 'Create a separate tracking entry' : 'Add to your portfolio'}
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
                <Label htmlFor="new-name">Name</Label>
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
                  <Label htmlFor="new-symbol">Symbol</Label>
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
                  <Label htmlFor="new-currency">Currency</Label>
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
                <Label htmlFor="new-price">Current Price</Label>
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
                <Label htmlFor="new-notes">Notes</Label>
                <Textarea 
                  id="new-notes" 
                  rows={2} 
                  value={newInvestmentForm.notes} 
                  onChange={(e) => setNewInvestmentForm(f => ({ ...f, notes: e.target.value }))}
                  maxLength={500} 
                />
              </div>
            </div>
            <div className="flex justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('choose')}>
                Back
              </Button>
              <Button type="submit">Create Investment</Button>
            </div>
          </form>
        )}

        {step === 'transaction' && existingInvestment && (
          <form onSubmit={handleAddTransaction} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
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
                <Label htmlFor="txn-date">Date</Label>
                <Input 
                  id="txn-date" 
                  type="date" 
                  value={transactionForm.date} 
                  onChange={(e) => setTransactionForm(f => ({ ...f, date: e.target.value }))} 
                  required 
                />
              </div>

              {showUnits && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="txn-units">Units / Shares</Label>
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
                    <Label htmlFor="txn-ppu">Price per Unit</Label>
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
                  Total Amount ({existingInvestment.currency})
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
                    <Label htmlFor="txn-fees">Fees</Label>
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
                    <Label htmlFor="txn-taxes">Taxes</Label>
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
              <Label htmlFor="txn-note">Note</Label>
              <Textarea 
                id="txn-note" 
                placeholder="Optional note…" 
                rows={2} 
                value={transactionForm.note} 
                onChange={(e) => setTransactionForm(f => ({ ...f, note: e.target.value }))} 
                maxLength={300} 
              />
            </div>

            <div className="flex justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('choose')}>
                Back
              </Button>
              <Button type="submit">Record Transaction</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}