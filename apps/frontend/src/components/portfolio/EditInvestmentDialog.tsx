import { useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePortfolio } from '@/hooks/usePortfolio';
import { toast } from 'sonner';
import type { InvestmentSummary } from '@/types/portfolio';
import { isUnitBased } from '@/utils/assetClass';
import type { PriceProvider } from '@/types/api';

interface Props {
  investment: InvestmentSummary;
  trigger?: React.ReactNode;
}

export function EditInvestmentDialog({ investment, trigger }: Props) {
  const { t } = useLanguage();
  const { updateInvestment } = usePortfolio();
  const [open, setOpen] = useState(false);

  const [form, setForm] = useState({
    name: investment.name,
    symbol: investment.symbol || '',
    currency: investment.currency || 'EUR',
    currentPrice: investment.currentPrice != null
      ? String(investment.currentPrice)
      : investment.current_price != null
        ? String(investment.current_price)
        : '',
    priceProvider: (investment.price_provider || 'manual') as PriceProvider,
    priceProviderId: investment.price_provider_id || '',
    priceProviderUrl: investment.price_provider_url || '',
    priceProviderLatestUrl: investment.price_provider_latest_url || '',
    priceProviderLatestPath: investment.price_provider_latest_path || '',
    priceProviderHistoryUrl: investment.price_provider_history_url || '',
    priceProviderHistoryPath: investment.price_provider_history_path || 'points',
    priceProviderHistoryTsPath: investment.price_provider_history_ts_path || 'timestamp_ms',
    priceProviderHistoryPricePath: investment.price_provider_history_price_path || 'price',
  });

  const unitBased = unitBased(investment.assetClass);

  const PRICE_PROVIDERS: { key: PriceProvider; name: string; hint: string }[] = [
    { key: 'manual', name: t('addInv.provider.manual'), hint: t('addInv.provider.hint.manual') },
    { key: 'binance', name: 'Binance', hint: t('addInv.provider.hint.binance') },
    { key: 'yahoo', name: 'Yahoo Finance', hint: t('addInv.provider.hint.yahoo') },
    { key: 'kinesis', name: 'Kinesis', hint: t('addInv.provider.hint.kinesis') },
    { key: 'custom', name: 'Custom JSON', hint: t('addInv.provider.hint.custom') },
  ];

  const reset = () => {
    setForm({
      name: investment.name,
      symbol: investment.symbol || '',
      currency: investment.currency || 'EUR',
      currentPrice: investment.currentPrice != null
        ? String(investment.currentPrice)
        : investment.current_price != null
          ? String(investment.current_price)
          : '',
      priceProvider: (investment.price_provider || 'manual') as PriceProvider,
      priceProviderId: investment.price_provider_id || '',
      priceProviderUrl: investment.price_provider_url || '',
      priceProviderLatestUrl: investment.price_provider_latest_url || '',
      priceProviderLatestPath: investment.price_provider_latest_path || '',
      priceProviderHistoryUrl: investment.price_provider_history_url || '',
      priceProviderHistoryPath: investment.price_provider_history_path || 'points',
      priceProviderHistoryTsPath: investment.price_provider_history_ts_path || 'timestamp_ms',
      priceProviderHistoryPricePath: investment.price_provider_history_price_path || 'price',
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name.trim()) return;
    if (unitBased && !form.symbol.trim()) {
      toast.error(t('invEdit.symbolRequired'));
      return;
    }

    try {
      await updateInvestment(investment.id, {
        name: form.name.trim(),
        symbol: unitBased ? form.symbol.trim().toUpperCase() : undefined,
        currency: form.currency,
        current_price: form.priceProvider === 'manual' && form.currentPrice
          ? parseFloat(form.currentPrice)
          : undefined,
        price_provider: form.priceProvider,
        price_provider_id: form.priceProviderId.trim() || undefined,
        price_provider_url: form.priceProviderUrl.trim() || undefined,
        price_provider_latest_url: form.priceProviderLatestUrl.trim() || undefined,
        price_provider_latest_path: form.priceProviderLatestPath.trim() || undefined,
        price_provider_history_url: form.priceProviderHistoryUrl.trim() || undefined,
        price_provider_history_path: form.priceProviderHistoryPath.trim() || undefined,
        price_provider_history_ts_path: form.priceProviderHistoryTsPath.trim() || undefined,
        price_provider_history_price_path: form.priceProviderHistoryPricePath.trim() || undefined,
      });
      toast.success(t('invEdit.toast.updated', { name: form.name.trim() }));
      setOpen(false);
    } catch {
      // handled in hook
    }
  };

  const selectedProvider = PRICE_PROVIDERS.find((p) => p.key === form.priceProvider);

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
          <DialogTitle>{t('invEdit.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('invEdit.title')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-inv-name">{t('addInv.label.name')}</Label>
            <Input
              id="edit-inv-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              maxLength={100}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {unitBased && (
              <div className="space-y-2">
                <Label htmlFor="edit-inv-symbol">{t('addInv.label.ticker')}</Label>
                <Input
                  id="edit-inv-symbol"
                  value={form.symbol}
                  onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                  maxLength={20}
                  className="font-mono"
                  required
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="edit-inv-currency">{t('addInv.label.currency')}</Label>
              <Select value={form.currency} onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}>
                <SelectTrigger id="edit-inv-currency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['EUR', 'USD', 'GBP', 'CHF', 'SAR', 'BTC'].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-border">
            <Label className="text-sm font-medium">{t('addInv.label.priceProvider')}</Label>
            <Select
              value={form.priceProvider}
              onValueChange={(v) => setForm((f) => ({ ...f, priceProvider: v as PriceProvider, priceProviderId: '' }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRICE_PROVIDERS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground ml-2 text-xs">— {p.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {form.priceProvider !== 'manual' && form.priceProvider !== 'custom' && (
              <div className="space-y-2">
                <Label htmlFor="edit-inv-provider-id" className="text-xs">
                  {t('addInv.label.providerId')}
                </Label>
                <Input
                  id="edit-inv-provider-id"
                  placeholder={selectedProvider?.hint || ''}
                  value={form.priceProviderId}
                  onChange={(e) => setForm((f) => ({ ...f, priceProviderId: e.target.value }))}
                  maxLength={200}
                  className="font-mono text-sm"
                />
              </div>
            )}

            {unitBased && form.priceProvider === 'manual' && (
              <div className="space-y-2">
                <Label htmlFor="edit-inv-price" className="text-xs">{t('addInv.label.currentPrice')}</Label>
                <Input
                  id="edit-inv-price"
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="0.00"
                  value={form.currentPrice}
                  onChange={(e) => setForm((f) => ({ ...f, currentPrice: e.target.value }))}
                />
              </div>
            )}

            {form.priceProvider === 'custom' && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-inv-provider-latest-url" className="text-xs">{t('addInv.label.latestJsonEndpoint')}</Label>
                  <Input
                    id="edit-inv-provider-latest-url"
                    type="url"
                    placeholder={t('addInv.placeholder.jsonEndpoint')}
                    value={form.priceProviderLatestUrl}
                    onChange={(e) => setForm((f) => ({ ...f, priceProviderLatestUrl: e.target.value }))}
                    maxLength={500}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-inv-provider-latest-path" className="text-xs">{t('addInv.label.latestJsonPath')}</Label>
                  <Input
                    id="edit-inv-provider-latest-path"
                    placeholder="price"
                    value={form.priceProviderLatestPath}
                    onChange={(e) => setForm((f) => ({ ...f, priceProviderLatestPath: e.target.value }))}
                    maxLength={300}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-inv-provider-history-url" className="text-xs">{t('addInv.label.historyJsonEndpoint')}</Label>
                  <Input
                    id="edit-inv-provider-history-url"
                    type="url"
                    placeholder={t('addInv.placeholder.jsonEndpoint')}
                    value={form.priceProviderHistoryUrl}
                    onChange={(e) => setForm((f) => ({ ...f, priceProviderHistoryUrl: e.target.value }))}
                    maxLength={500}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-inv-provider-history-path" className="text-xs">{t('addInv.label.historyArrayPath')}</Label>
                  <Input
                    id="edit-inv-provider-history-path"
                    placeholder="points"
                    value={form.priceProviderHistoryPath}
                    onChange={(e) => setForm((f) => ({ ...f, priceProviderHistoryPath: e.target.value }))}
                    maxLength={300}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="edit-inv-provider-history-ts" className="text-xs">{t('addInv.label.historyTimestampPath')}</Label>
                    <Input
                      id="edit-inv-provider-history-ts"
                      placeholder="timestamp_ms"
                      value={form.priceProviderHistoryTsPath}
                      onChange={(e) => setForm((f) => ({ ...f, priceProviderHistoryTsPath: e.target.value }))}
                      maxLength={300}
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-inv-provider-history-price" className="text-xs">{t('addInv.label.historyPricePath')}</Label>
                    <Input
                      id="edit-inv-provider-history-price"
                      placeholder="price"
                      value={form.priceProviderHistoryPricePath}
                      onChange={(e) => setForm((f) => ({ ...f, priceProviderHistoryPricePath: e.target.value }))}
                      maxLength={300}
                      className="font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            )}
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
