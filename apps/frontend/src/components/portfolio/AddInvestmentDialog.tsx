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
import { ASSET_CLASS_LABELS, getAssetClassLabel } from '@/types/portfolio';
import type { PriceProvider } from '@/types/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

const ASSET_ICONS: Record<AssetClass, typeof TrendingUp> = {
  stock: TrendingUp,
  etf: BarChart3,
  crypto: Bitcoin,
  real_estate: Building2,
  savings: PiggyBank,
  bond: PiggyBank,
};

export function AddInvestmentDialog() {
  const { t } = useLanguage();
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
    municipality: '',
    cadastralIncome: '',
    municipalityTaxRate: '',
    notes: '',
    priceProvider: 'manual' as PriceProvider,
    priceProviderId: '',
    priceProviderUrl: '',
    addInitialPurchase: true,
    initialAmount: '',
    initialUnits: '',
    initialDate: new Date().toISOString().slice(0, 10),
    initialFees: '',
  });

  const ASSET_DESCRIPTIONS: Record<AssetClass, string> = {
    stock: t('addInv.desc.stock'),
    etf: t('addInv.desc.etf'),
    crypto: t('addInv.desc.crypto'),
    real_estate: t('addInv.desc.real_estate'),
    savings: t('addInv.desc.savings'),
    bond: t('addInv.desc.bond'),
  };

  const PRICE_PROVIDERS: { key: PriceProvider; name: string; hint: string }[] = [
    { key: 'manual', name: t('addInv.provider.manual'), hint: t('addInv.provider.hint.manual') },
    { key: 'coingecko', name: 'CoinGecko', hint: t('addInv.provider.hint.coingecko') },
    { key: 'yahoo', name: 'Yahoo Finance', hint: t('addInv.provider.hint.yahoo') },
    { key: 'kraken', name: 'Kraken', hint: t('addInv.provider.hint.kraken') },
    { key: 'custom', name: 'Custom JSON', hint: t('addInv.provider.hint.custom') },
  ];

  const reset = () => {
    setForm({
      assetClass: '', name: '', symbol: '', currency: 'EUR', currentPrice: '',
      interestRate: '', maturityDate: '', location: '', municipality: '', cadastralIncome: '', municipalityTaxRate: '', notes: '',
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
        municipality: form.municipality.trim() || undefined,
        cadastral_income: form.cadastralIncome ? parseFloat(form.cadastralIncome) : undefined,
        municipality_tax_rate: form.municipalityTaxRate ? parseFloat(form.municipalityTaxRate) : undefined,
        notes: form.notes.trim() || undefined,
        price_provider: form.priceProvider,
        price_provider_id: form.priceProviderId.trim() || undefined,
        price_provider_url: form.priceProviderUrl.trim() || undefined,
      });

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
            note: t('addInv.initialPurchaseNote'),
          });
        }
      }

      toast.success(t('addInv.toast.added', { assetClass: getAssetClassLabel(t, form.assetClass), name: form.name }));
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

  const computedPricePerUnit = form.initialAmount && form.initialUnits
    ? (parseFloat(form.initialAmount) / parseFloat(form.initialUnits)).toFixed(4)
    : '';

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" /> {t('addInv.title')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'type' ? t('addInv.chooseType') : t('addInv.assetTitle', { assetClass: form.assetClass ? getAssetClassLabel(t, form.assetClass) : t('addInv.title') })}
          </DialogTitle>
          {step === 'type' && (
            <DialogDescription>
              {t('addInv.chooseTypeDesc')}
            </DialogDescription>
          )}
        </DialogHeader>

        {step === 'type' ? (
          <div className="grid grid-cols-2 gap-3">
            {(Object.keys(ASSET_CLASS_LABELS) as AssetClass[]).map((key) => {
              const Icon = ASSET_ICONS[key];
              const label = getAssetClassLabel(t, key);
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
                <Label htmlFor="inv-name">{t('addInv.label.name')}</Label>
                <Input
                  id="inv-name"
                  placeholder={
                    isUnitBased ? t('addInv.placeholder.name.stock') :
                    isRealEstate ? t('addInv.placeholder.name.property') :
                    t('addInv.placeholder.name.savings')
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
                    <Label htmlFor="inv-symbol">{t('addInv.label.ticker')}</Label>
                    <Input
                      id="inv-symbol"
                      placeholder={t('addInv.placeholder.ticker')}
                      value={form.symbol}
                      onChange={(e) => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                      maxLength={20}
                      className="font-mono"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="inv-currency">{t('addInv.label.currency')}</Label>
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
                    <Label htmlFor="inv-rate">{t('addInv.label.interestRate')}</Label>
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
                    <Label htmlFor="inv-maturity">{t('addInv.label.maturityDate')}</Label>
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
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="inv-location">{t('addInv.label.location')}</Label>
                      <Input
                        id="inv-location"
                        placeholder={t('addInv.placeholder.location')}
                        value={form.location}
                        onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))}
                        maxLength={200}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="inv-municipality">{t('addInv.label.municipality')}</Label>
                      <Input
                        id="inv-municipality"
                        placeholder={t('addInv.placeholder.municipality')}
                        value={form.municipality}
                        onChange={(e) => setForm(f => ({ ...f, municipality: e.target.value }))}
                        maxLength={200}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="inv-cadastral-income">{t('addInv.label.cadastralIncome')}</Label>
                      <Input
                        id="inv-cadastral-income"
                        type="number"
                        min="0"
                        step="1"
                        placeholder={t('addInv.placeholder.cadastralIncome')}
                        value={form.cadastralIncome}
                        onChange={(e) => setForm(f => ({ ...f, cadastralIncome: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="inv-municipality-tax-rate">{t('addInv.label.municipalityTaxRate')}</Label>
                      <Input
                        id="inv-municipality-tax-rate"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder={t('addInv.placeholder.municipalityTaxRate')}
                        value={form.municipalityTaxRate}
                        onChange={(e) => setForm(f => ({ ...f, municipalityTaxRate: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Initial Purchase Section */}
            <div className="rounded-lg border border-border p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">
                    {t('addInv.initial.label', {
                      txType: isRealEstate ? t('addInv.initial.purchase') : isFixedIncome ? t('addInv.initial.deposit') : t('addInv.initial.buy')
                    })}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('addInv.initial.desc', {
                      txWord: isRealEstate ? t('addInv.initial.purchaseWord') : isFixedIncome ? t('addInv.initial.depositWord') : t('addInv.initial.transactionWord')
                    })}
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
                      <Label htmlFor="init-date" className="text-xs">{t('addInv.label.date')}</Label>
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
                        {isRealEstate ? t('addInv.label.purchasePrice') : isFixedIncome ? t('addInv.label.depositAmount') : t('addInv.label.totalCost')} *
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
                        <Label htmlFor="init-units" className="text-xs">{t('addInv.label.units')}</Label>
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
                        <Label className="text-xs">{t('addInv.label.pricePerUnit')}</Label>
                        <div className="h-9 px-3 flex items-center rounded-md border border-input bg-muted/50 text-sm text-muted-foreground font-mono">
                          {computedPricePerUnit || '—'}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="init-fees" className="text-xs">{t('addInv.label.fees')}</Label>
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

            {/* Price Provider Section */}
            {isUnitBased && (
              <div className="space-y-3 pt-2 border-t border-border">
                <Label className="text-sm font-medium">{t('addInv.label.priceProvider')}</Label>
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
                      {form.priceProvider === 'custom' ? t('addInv.label.jsonPath') : t('addInv.label.providerId')}
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
                    <Label htmlFor="inv-provider-url" className="text-xs">{t('addInv.label.jsonEndpoint')}</Label>
                    <Input
                      id="inv-provider-url"
                      type="url"
                      placeholder={t('addInv.placeholder.jsonEndpoint')}
                      value={form.priceProviderUrl}
                      onChange={(e) => setForm(f => ({ ...f, priceProviderUrl: e.target.value }))}
                      maxLength={500}
                      className="font-mono text-sm"
                    />
                  </div>
                )}

                {isUnitBased && form.priceProvider === 'manual' && (
                  <div className="space-y-2">
                    <Label htmlFor="inv-price" className="text-xs">{t('addInv.label.currentPrice')}</Label>
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
              <Label htmlFor="inv-notes">{t('addInv.label.notes')}</Label>
              <Textarea
                id="inv-notes"
                placeholder={t('addInv.placeholder.notes')}
                rows={2}
                value={form.notes}
                onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                maxLength={500}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => setStep('type')}>{t('addInv.back')}</Button>
              <Button type="submit" className="gap-1.5">
                {t('addInv.create')} <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
