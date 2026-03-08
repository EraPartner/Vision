import { useState } from 'react';
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
import { TXN_TYPE_LABELS } from '@/types/portfolio';
import { toast } from 'sonner';

interface Props {
  investment: InvestmentSummary;
  trigger?: React.ReactNode;
}

const RECURRENCE_LABELS: Record<RecurrenceInterval, string> = {
  daily: 'Daily', weekly: 'Weekly', 'bi-weekly': 'Bi-weekly',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
};

export function AddPortfolioTxnDialog({ investment, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const { addTransaction } = usePortfolio();

  const isUnitBased = ['stock', 'etf', 'crypto'].includes(investment.assetClass);
  const isRealEstate = investment.assetClass === 'real_estate';
  const isFixedIncome = ['savings', 'bond'].includes(investment.assetClass);

  // Filter relevant transaction types per asset class
  const allowedTypes: PortfolioTxnType[] = (() => {
    if (isUnitBased) return ['buy', 'sell', 'dividend', 'fee', 'tax'];
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
    note: '',
    isRecurring: false,
    recurrenceInterval: 'monthly' as RecurrenceInterval,
    recurrenceEndDate: '',
  });

  const reset = () => setForm({
    type: 'buy', date: new Date().toISOString().slice(0, 10),
    amount: '', units: '', pricePerUnit: '', fees: '', taxes: '', note: '',
    isRecurring: false, recurrenceInterval: 'monthly', recurrenceEndDate: '',
  });

  // Auto-calculate amount from units * price
  const computedAmount = form.units && form.pricePerUnit
    ? (parseFloat(form.units) * parseFloat(form.pricePerUnit)).toFixed(2)
    : '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(form.amount || computedAmount);
    if (!amount || isNaN(amount)) { toast.error('Amount is required'); return; }

    addTransaction({
      investmentId: investment.id,
      type: form.type,
      date: form.date,
      amount,
      units: form.units ? parseFloat(form.units) : undefined,
      price_per_unit: form.pricePerUnit ? parseFloat(form.pricePerUnit) : undefined,
      fees: form.fees ? parseFloat(form.fees) : undefined,
      taxes: form.taxes ? parseFloat(form.taxes) : undefined,
      currency: investment.currency,
      note: form.note.trim() || undefined,
      is_recurring: form.isRecurring,
      recurrence_interval: form.isRecurring ? form.recurrenceInterval : undefined,
      recurrence_end_date: form.isRecurring && form.recurrenceEndDate ? form.recurrenceEndDate : undefined,
    });

    toast.success(`${TXN_TYPE_LABELS[form.type]} recorded for ${investment.name}`);
    reset();
    setOpen(false);
  };

  const showUnits = isUnitBased && ['buy', 'sell'].includes(form.type);
  const showFeesTaxes = ['buy', 'sell'].includes(form.type);
  const showRecurring = ['buy', 'sell', 'dividend', 'interest', 'rent_income'].includes(form.type);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="gap-1.5">
            <Plus className="h-4 w-4" /> Add Transaction
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record Transaction — {investment.symbol || investment.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm(f => ({ ...f, type: v as PortfolioTxnType }))}>
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
              <Input id="txn-date" type="date" value={form.date} onChange={(e) => setForm(f => ({ ...f, date: e.target.value }))} required />
            </div>

            {showUnits && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="txn-units">Units / Shares</Label>
                  <Input id="txn-units" type="number" step="0.000001" min="0" placeholder="10" value={form.units} onChange={(e) => setForm(f => ({ ...f, units: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="txn-ppu">Price per Unit</Label>
                  <Input id="txn-ppu" type="number" step="0.0001" min="0" placeholder="98.50" value={form.pricePerUnit} onChange={(e) => setForm(f => ({ ...f, pricePerUnit: e.target.value }))} />
                </div>
              </>
            )}

            <div className={`space-y-2 ${showUnits ? 'col-span-2' : ''}`}>
              <Label htmlFor="txn-amount">
                Total Amount ({investment.currency})
                {computedAmount && <span className="text-muted-foreground ml-1 text-xs">= {computedAmount}</span>}
              </Label>
              <Input id="txn-amount" type="number" step="0.01" min="0" placeholder={computedAmount || '0.00'} value={form.amount} onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>

            {showFeesTaxes && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="txn-fees">Fees</Label>
                  <Input id="txn-fees" type="number" step="0.01" min="0" placeholder="0.00" value={form.fees} onChange={(e) => setForm(f => ({ ...f, fees: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="txn-taxes">Taxes</Label>
                  <Input id="txn-taxes" type="number" step="0.01" min="0" placeholder="0.00" value={form.taxes} onChange={(e) => setForm(f => ({ ...f, taxes: e.target.value }))} />
                </div>
              </>
            )}
          </div>

          {showRecurring && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="txn-recurring" className="text-sm">Recurring</Label>
                <Switch id="txn-recurring" checked={form.isRecurring} onCheckedChange={(v) => setForm(f => ({ ...f, isRecurring: v }))} />
              </div>
              {form.isRecurring && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Interval</Label>
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
                    <Label className="text-xs">End Date (optional)</Label>
                    <Input type="date" className="h-8 text-xs" value={form.recurrenceEndDate} onChange={(e) => setForm(f => ({ ...f, recurrenceEndDate: e.target.value }))} />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="txn-note">Note</Label>
            <Textarea id="txn-note" placeholder="Optional note…" rows={2} value={form.note} onChange={(e) => setForm(f => ({ ...f, note: e.target.value }))} maxLength={300} />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit">Record</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
