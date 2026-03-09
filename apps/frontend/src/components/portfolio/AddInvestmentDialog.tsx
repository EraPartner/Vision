import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Plus, TrendingUp, Bitcoin, Building2, PiggyBank, BarChart3, ArrowRight } from 'lucide-react';
import { usePortfolio } from '@/hooks/usePortfolio';
import type { AssetClass } from '@/types/portfolio';
import { ASSET_CLASS_LABELS } from '@/types/portfolio';
import type { PriceProvider } from '@/types/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const ASSET_ICONS: Record<AssetClass, typeof TrendingUp> = {
  stock: TrendingUp,
  etf: BarChart3,
  crypto: Bitcoin,
  real_estate: Building2,
  savings: PiggyBank,
  bond: PiggyBank,
};

const ASSET_DESCRIPTIONS: Record<AssetClass, string> = {
  stock: 'Track individual stocks with weighted average cost basis and dividend tracking.',
  etf: 'Track ETF holdings with automatic cost basis and performance calculations.',
  crypto: 'Track cryptocurrency with live price updates and capital gains.',
  real_estate: 'Track properties with purchase price, appreciation, and rental income.',
  savings: 'Track savings accounts with interest rate projections.',
  bond: 'Track bonds with maturity dates and interest payments.',
};

const PRICE_PROVIDERS: { key: PriceProvider; name: string; hint: string }[] = [
  { key: 'manual', name: 'Manual', hint: 'Set price manually' },
  { key: 'coingecko', name: 'CoinGecko', hint: 'Coin ID (e.g. bitcoin, ethereum)' },
  { key: 'yahoo', name: 'Yahoo Finance', hint: 'Ticker (e.g. AAPL, VWCE.DE)' },
  { key: 'kraken', name: 'Kraken', hint: 'Pair (e.g. XBTUSD, ETHUSD)' },
  { key: 'custom', name: 'Custom JSON', hint: 'JSON path to price (e.g. data.price)' },
];

export function AddInvestmentDialog() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'type' | 'details'>('type');
  const { addInvestment, addTransaction } = usePortfolio();
  const [form, setForm] = useState({
    assetClass: '' as AssetClass | '',
    name: '',
    symbol: '',
    currency: 'EUR',
    currentPrice: '',
    interestRate: '',
    maturityDate: '',
    location: '',
    notes: '',
    priceProvider: 'manual' as PriceProvider,
    priceProviderId: '',
    priceProviderUrl: '',
    // Initial purchase fields
    addInitialPurchase: true,
    initialAmount: '',
    initialUnits: '',
    initialDate: new Date().toISOString().slice(0, 10),
    initialFees: '',
  });

  const reset = () => {
    setForm({ 
      assetClass: '', name: '', symbol: '', currency: 'EUR', currentPrice: '', 
      interestRate: '', maturityDate: '', location: '', notes: '', 
      priceProvider: 'manual', priceProviderId: '', priceProviderUrl: '',
      addInitialPurchase: true, initialAmount: '', initialUnits: '', 
      initialDate: new Date().toISOString().slice(0, 10), initialFees: '',
    });
    setStep('type');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.assetClass || !form.name.trim()) return;

    try {
      const investment = await addInvestment({
        name: form.name.trim(),
        symbol: form.symbol.trim() || undefined,
        asset_class: form.assetClass,
        currency: form.currency || 'EUR',
        current_price: form.currentPrice ? parseFloat(form.currentPrice) : undefined,
        interest_rate: form.interestRate ? parseFloat(form.interestRate) : undefined,
        maturity_date: form.maturityDate || undefined,
        location: form.location.trim() || undefined,
        notes: form.notes.trim() || undefined,
        price_provider: form.priceProvider,
        price_provider_id: form.priceProviderId.trim() || undefined,
        price_provider_url: form.priceProviderUrl.trim() || undefined,
      });

      // Add initial purchase transaction if specified
      if (form.addInitialPurchase && form.initialAmount && investment) {
        const amount = parseFloat(form.initialAmount);
        const units = form.initialUnits ? parseFloat(form.initialUnits) : undefined;
        const fees = form.initialFees ? parseFloat(form.initialFees) : undefined;
        
        if (amount > 0) {
          await addTransaction({
            investmentId: investment.id,
            type: 'buy',
            date: form.initialDate,
            amount,
            units,
            price_per_unit: units ? amount / units : undefined,
            fees,
            currency: form.currency || 'EUR',
            note: 'Initial purchase',
          });
        }
      }

      toast.success(`${ASSET_CLASS_LABELS[form.assetClass]} "${form.name}" added`);
      reset();
      setOpen(false);
    } catch {
      // error handled by hook
    }
  };

  const isUnitBased = ['stock', 'etf', 'crypto'].includes(form.assetClass);
  const isFixedIncome = ['savings', 'bond'].includes(form.assetClass);
  const isRealEstate = form.assetClass === 'real_estate';
  const selectedProvider = PRICE_PROVIDERS.find(p => p.key === form.priceProvider);

  // Calculate price per unit for display
  const computedPricePerUnit = form.initialAmount && form.initialUnits
    ? (parseFloat(form.initialAmount) / parseFloat(form.initialUnits)).toFixed(4)
    : '';

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" /> Add Investment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'type' ? 'Choose Asset Type' : `Add ${form.assetClass ? ASSET_CLASS_LABELS[form.assetClass] : 'Investment'}`}
          </DialogTitle>
          {step === 'type' && (
            <DialogDescription>
              Select the type of investment you want to track
            </DialogDescription>
          )}
        </DialogHeader>

        {step === 'type' ? (
          <div className="grid grid-cols-2 gap-3">
            {(Object.entries(ASSET_CLASS_LABELS) as [AssetClass, string][]).map(([key, label]) => {
              const Icon = ASSET_ICONS[key];
              return (
                <button
                  key={key}
                  onClick={() => {
                    const defaultProvider = key === 'crypto' ? 'coingecko' : ['stock', 'etf'].includes(key) ? 'yahoo' : 'manual';
                    setForm(f => ({ ...f, assetClass: key, priceProvider: defaultProvider as PriceProvider }));
                    setStep('details');
                  }}
                  className={cn(
                    'flex flex-col items-start gap-2 p-4 rounded-lg border border-border text-left',
                    'hover:border-primary hover:bg-primary/5 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  )}
                >
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <span className="text-sm font-medium text-foreground">{label}</span>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {ASSET_DESCRIPTIONS[key]}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Basic Info */}
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="inv-name">Name *</Label>
                <Input 
                  id="inv-name" 
                  placeholder={
                    isUnitBased ? 'e.g. Apple Inc. or Vanguard FTSE' : 
                    isRealEstate ? 'e.g. Downtown Apartment' : 
                    'e.g. Emergency Fund'
                  } 
                  value={form.name} 
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} 
                  maxLength={100} 
                  required 
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {isUnitBased && (
                  <div className="space-y-2">
                    <Label htmlFor="inv-symbol">Ticker / Symbol</Label>
                    <Input 
                      id="inv-symbol" 
                      placeholder="e.g. AAPL, BTC" 
                      value={form.symbol} 
                      onChange={(e) => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} 
                      maxLength={20} 
                      className="font-mono" 
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="inv-currency">Currency</Label>
                  <Select value={form.currency} onValueChange={(v) => setForm(f => ({ ...f, currency: v }))}>
                    <SelectTrigger id="inv-currency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['EUR', 'USD', 'GBP', 'CHF', 'SAR', 'BTC'].map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isFixedIncome && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="inv-rate">Interest Rate (% p.a.)</Label>
                    <Input 
                      id="inv-rate" 
                      type="number" 
                      step="0.01" 
                      min="0" 
                      max="100" 
                      placeholder="3.50" 
                      value={form.interestRate} 
                      onChange={(e) => setForm(f => ({ ...f, interestRate: e.target.value }))} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="inv-maturity">Maturity Date</Label>
                    <Input 
                      id="inv-maturity" 
                      type="date" 
                      value={form.maturityDate} 
                      onChange={(e) => setForm(f => ({ ...f, maturityDate: e.target.value }))} 
                    />
                  </div>
                </div>
              )}

              {isRealEstate && (
                <div className="space-y-2">
                  <Label htmlFor="inv-location">Location</Label>
                  <Input 
                    id="inv-location" 
                    placeholder="e.g. Brussels, Belgium" 
                    value={form.location} 
                    onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))} 
                    maxLength={200} 
                  />
                </div>
              )}
            </div>

            {/* Initial Purchase Section */}
            <div className="rounded-lg border border-border p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Initial {isRealEstate ? 'Purchase' : isFixedIncome ? 'Deposit' : 'Buy'}</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Record your first {isRealEstate ? 'purchase' : isFixedIncome ? 'deposit' : 'transaction'} now
                  </p>
                </div>
                <Switch 
                  checked={form.addInitialPurchase} 
                  onCheckedChange={(v) => setForm(f => ({ ...f, addInitialPurchase: v }))} 
                />
              </div>

              {form.addInitialPurchase && (
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="init-date" className="text-xs">Date</Label>
                      <Input 
                        id="init-date" 
                        type="date" 
                        className="h-9"
                        value={form.initialDate} 
                        onChange={(e) => setForm(f => ({ ...f, initialDate: e.target.value }))} 
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="init-amount" className="text-xs">
                        {isRealEstate ? 'Purchase Price' : isFixedIncome ? 'Deposit Amount' : 'Total Cost'} *
                      </Label>
                      <Input 
                        id="init-amount" 
                        type="number" 
                        step="0.01" 
                        min="0" 
                        className="h-9"
                        placeholder="10000.00" 
                        value={form.initialAmount} 
                        onChange={(e) => setForm(f => ({ ...f, initialAmount: e.target.value }))} 
                      />
                    </div>
                  </div>

                  {isUnitBased && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="init-units" className="text-xs">Units / Shares</Label>
                        <Input 
                          id="init-units" 
                          type="number" 
                          step="0.000001" 
                          min="0" 
                          className="h-9"
                          placeholder="100" 
                          value={form.initialUnits} 
                          onChange={(e) => setForm(f => ({ ...f, initialUnits: e.target.value }))} 
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Price per Unit</Label>
                        <div className="h-9 px-3 flex items-center rounded-md border border-input bg-muted/50 text-sm text-muted-foreground font-mono">
                          {computedPricePerUnit || '—'}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="init-fees" className="text-xs">Fees (optional)</Label>
                    <Input 
                      id="init-fees" 
                      type="number" 
                      step="0.01" 
                      min="0" 
                      className="h-9"
                      placeholder="0.00" 
                      value={form.initialFees} 
                      onChange={(e) => setForm(f => ({ ...f, initialFees: e.target.value }))} 
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Price Provider Section - Unit Based Only */}
            {isUnitBased && (
              <div className="space-y-3 pt-2 border-t border-border">
                <Label className="text-sm font-medium">Live Price Provider</Label>
                <Select value={form.priceProvider} onValueChange={(v) => setForm(f => ({ ...f, priceProvider: v as PriceProvider, priceProviderId: '' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRICE_PROVIDERS.map(p => (
                      <SelectItem key={p.key} value={p.key}>
                        <span className="font-medium">{p.name}</span>
                        <span className="text-muted-foreground ml-2 text-xs">— {p.hint}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {form.priceProvider !== 'manual' && (
                  <div className="space-y-2">
                    <Label htmlFor="inv-provider-id" className="text-xs">
                      {form.priceProvider === 'custom' ? 'JSON Price Path' : 'Provider ID'}
                    </Label>
                    <Input
                      id="inv-provider-id"
                      placeholder={selectedProvider?.hint || ''}
                      value={form.priceProviderId}
                      onChange={(e) => setForm(f => ({ ...f, priceProviderId: e.target.value }))}
                      maxLength={200}
                      className="font-mono text-sm"
                    />
                  </div>
                )}

                {form.priceProvider === 'custom' && (
                  <div className="space-y-2">
                    <Label htmlFor="inv-provider-url" className="text-xs">JSON Endpoint URL</Label>
                    <Input
                      id="inv-provider-url"
                      type="url"
                      placeholder="https://api.example.com/price"
                      value={form.priceProviderUrl}
                      onChange={(e) => setForm(f => ({ ...f, priceProviderUrl: e.target.value }))}
                      maxLength={500}
                      className="font-mono text-sm"
                    />
                  </div>
                )}

                {isUnitBased && form.priceProvider === 'manual' && (
                  <div className="space-y-2">
                    <Label htmlFor="inv-price" className="text-xs">Current Price per Unit</Label>
                    <Input 
                      id="inv-price" 
                      type="number" 
                      step="0.0001" 
                      min="0" 
                      placeholder="0.00" 
                      value={form.currentPrice} 
                      onChange={(e) => setForm(f => ({ ...f, currentPrice: e.target.value }))} 
                    />
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="inv-notes">Notes</Label>
              <Textarea 
                id="inv-notes" 
                placeholder="Optional notes…" 
                rows={2} 
                value={form.notes} 
                onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} 
                maxLength={500} 
              />
            </div>

            {/* Actions */}
            <div className="flex justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => setStep('type')}>Back</Button>
              <Button type="submit" className="gap-1.5">
                Create <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
