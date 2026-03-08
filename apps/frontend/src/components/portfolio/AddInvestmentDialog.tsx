import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, TrendingUp, Bitcoin, Building2, PiggyBank, BarChart3 } from 'lucide-react';
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
  const { addInvestment } = usePortfolio();
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
  });

  const reset = () => {
    setForm({ assetClass: '', name: '', symbol: '', currency: 'EUR', currentPrice: '', interestRate: '', maturityDate: '', location: '', notes: '', priceProvider: 'manual', priceProviderId: '', priceProviderUrl: '' });
    setStep('type');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.assetClass || !form.name.trim()) return;

    try {
      await addInvestment({
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

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" /> Add Investment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === 'type' ? 'Choose Asset Type' : `Add ${form.assetClass ? ASSET_CLASS_LABELS[form.assetClass] : 'Investment'}`}</DialogTitle>
        </DialogHeader>

        {step === 'type' ? (
          <div className="grid grid-cols-2 gap-3">
            {(Object.entries(ASSET_CLASS_LABELS) as [AssetClass, string][]).map(([key, label]) => {
              const Icon = ASSET_ICONS[key];
              return (
                <button
                  key={key}
                  onClick={() => {
                    // Auto-suggest provider based on asset class
                    const defaultProvider = key === 'crypto' ? 'coingecko' : ['stock', 'etf'].includes(key) ? 'yahoo' : 'manual';
                    setForm(f => ({ ...f, assetClass: key, priceProvider: defaultProvider as PriceProvider }));
                    setStep('details');
                  }}
                  className={cn(
                    'flex flex-col items-center gap-2 p-4 rounded-lg border border-border',
                    'hover:border-primary hover:bg-primary/5 transition-colors text-center',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  )}
                >
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 col-span-2">
                <Label htmlFor="inv-name">Name *</Label>
                <Input id="inv-name" placeholder={isUnitBased ? 'e.g. Vanguard FTSE All-World' : isRealEstate ? 'e.g. City Apartment' : 'e.g. Emergency Fund'} value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} maxLength={100} required />
              </div>

              {isUnitBased && (
                <div className="space-y-2">
                  <Label htmlFor="inv-symbol">Ticker / Symbol</Label>
                  <Input id="inv-symbol" placeholder="e.g. VWCE" value={form.symbol} onChange={(e) => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} maxLength={20} className="font-mono" />
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

              {isUnitBased && (
                <div className="space-y-2">
                  <Label htmlFor="inv-price">Current Price per Unit</Label>
                  <Input id="inv-price" type="number" step="0.0001" min="0" placeholder="0.00" value={form.currentPrice} onChange={(e) => setForm(f => ({ ...f, currentPrice: e.target.value }))} />
                </div>
              )}

              {isFixedIncome && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="inv-rate">Interest Rate (%)</Label>
                    <Input id="inv-rate" type="number" step="0.01" min="0" max="100" placeholder="3.50" value={form.interestRate} onChange={(e) => setForm(f => ({ ...f, interestRate: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="inv-maturity">Maturity Date</Label>
                    <Input id="inv-maturity" type="date" value={form.maturityDate} onChange={(e) => setForm(f => ({ ...f, maturityDate: e.target.value }))} />
                  </div>
                </>
              )}

              {isRealEstate && (
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="inv-location">Location</Label>
                  <Input id="inv-location" placeholder="e.g. Brussels, Belgium" value={form.location} onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))} maxLength={200} />
                </div>
              )}

              {/* Price Provider Section */}
              {isUnitBased && (
                <>
                  <div className="space-y-2 col-span-2 pt-2 border-t border-border">
                    <Label htmlFor="inv-provider" className="text-sm font-semibold">Live Price Provider</Label>
                    <Select value={form.priceProvider} onValueChange={(v) => setForm(f => ({ ...f, priceProvider: v as PriceProvider, priceProviderId: '' }))}>
                      <SelectTrigger id="inv-provider"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PRICE_PROVIDERS.map(p => (
                          <SelectItem key={p.key} value={p.key}>
                            <span className="font-medium">{p.name}</span>
                            <span className="text-muted-foreground ml-2 text-xs">— {p.hint}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {form.priceProvider !== 'manual' && (
                    <div className="space-y-2 col-span-2">
                      <Label htmlFor="inv-provider-id">
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
                      <p className="text-xs text-muted-foreground">{selectedProvider?.hint}</p>
                    </div>
                  )}

                  {form.priceProvider === 'custom' && (
                    <div className="space-y-2 col-span-2">
                      <Label htmlFor="inv-provider-url">JSON Endpoint URL</Label>
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
                </>
              )}

              <div className="space-y-2 col-span-2">
                <Label htmlFor="inv-notes">Notes</Label>
                <Textarea id="inv-notes" placeholder="Optional notes…" rows={2} value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} maxLength={500} />
              </div>
            </div>

            <div className="flex justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('type')}>Back</Button>
              <Button type="submit">Create Investment</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
