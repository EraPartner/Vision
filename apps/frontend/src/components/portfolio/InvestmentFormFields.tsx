import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DatePicker } from '@/components/shared/DatePicker';
import { parseLocalDateFromYmd, toYmd } from '@/components/shared/dateUtils';
import type { PriceProvider } from '@/types/api';

export interface InvestmentForm {
  assetClass: string;
  name: string;
  symbol: string;
  currency: string;
  currentPrice: string;
  interestRate: string;
  maturityDate: string;
  location: string;
  municipality: string;
  cadastralIncome: string;
  municipalityTaxRate: string;
  notes: string;
  priceProvider: PriceProvider;
  priceProviderId: string;
  priceProviderUrl: string;
  priceProviderLatestUrl: string;
  priceProviderLatestPath: string;
  priceProviderHistoryUrl: string;
  priceProviderHistoryPath: string;
  priceProviderHistoryTsPath: string;
  priceProviderHistoryPricePath: string;
  addInitialPurchase: boolean;
  initialAmount: string;
  initialUnits: string;
  initialDate: string;
  initialFees: string;
}

interface PriceProviderOption {
  key: PriceProvider;
  name: string;
  hint: string;
}

interface InvestmentFormFieldsProps {
  form: InvestmentForm;
  setForm: (updater: (prev: InvestmentForm) => InvestmentForm) => void;
  isUnitBased: boolean;
  isFixedIncome: boolean;
  isRealEstate: boolean;
  computedPricePerUnit: string;
  priceProviders: PriceProviderOption[];
  selectedProvider: PriceProviderOption | undefined;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function InvestmentFormFields({
  form, setForm, isUnitBased, isFixedIncome, isRealEstate,
  computedPricePerUnit, priceProviders, selectedProvider, t,
}: InvestmentFormFieldsProps) {
  return (
    <>
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
              <DatePicker
                value={form.maturityDate ? parseLocalDateFromYmd(form.maturityDate) : undefined}
                onChange={(date) => setForm(f => ({ ...f, maturityDate: date ? toYmd(date) : '' }))}
                placeholder={t('plannedPage.link.pickDate')}
                allowClear
                clearLabel={t('common.clear')}
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

      {/* Initial Purchase */}
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
            aria-label={t('addInv.initial.label', {
              txType: isRealEstate ? t('addInv.initial.purchase') : isFixedIncome ? t('addInv.initial.deposit') : t('addInv.initial.buy')
            })}
            checked={form.addInitialPurchase}
            onCheckedChange={(v) => setForm(f => ({ ...f, addInitialPurchase: v }))}
          />
        </div>

        {form.addInitialPurchase && (
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="init-date" className="text-xs">{t('addInv.label.date')}</Label>
                <DatePicker
                  value={form.initialDate ? parseLocalDateFromYmd(form.initialDate) : undefined}
                  onChange={(date) => setForm(f => ({ ...f, initialDate: date ? toYmd(date) : '' }))}
                  placeholder={t('plannedPage.link.pickDate')}
                  buttonClassName="h-9"
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

      {/* Price Provider */}
      {isUnitBased && (
        <div className="space-y-3 pt-2 border-t border-border">
          <Label className="text-sm font-medium">{t('addInv.label.priceProvider')}</Label>
          <Select value={form.priceProvider} onValueChange={(v) => setForm(f => ({ ...f, priceProvider: v as PriceProvider, priceProviderId: '' }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {priceProviders.map(p => (
                <SelectItem key={p.key} value={p.key}>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">— {p.hint}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {form.priceProvider !== 'manual' && form.priceProvider !== 'custom' && (
            <div className="space-y-2">
              <Label htmlFor="inv-provider-id" className="text-xs">{t('addInv.label.providerId')}</Label>
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
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="inv-provider-latest-url" className="text-xs">{t('addInv.label.latestJsonEndpoint')}</Label>
                <Input
                  id="inv-provider-latest-url"
                  type="url"
                  placeholder={t('addInv.placeholder.jsonEndpoint')}
                  value={form.priceProviderLatestUrl}
                  onChange={(e) => setForm(f => ({ ...f, priceProviderLatestUrl: e.target.value }))}
                  maxLength={500}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-provider-latest-path" className="text-xs">{t('addInv.label.latestJsonPath')}</Label>
                <Input
                  id="inv-provider-latest-path"
                  placeholder="price"
                  value={form.priceProviderLatestPath}
                  onChange={(e) => setForm(f => ({ ...f, priceProviderLatestPath: e.target.value }))}
                  maxLength={300}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-provider-history-url" className="text-xs">{t('addInv.label.historyJsonEndpoint')}</Label>
                <Input
                  id="inv-provider-history-url"
                  type="url"
                  placeholder={t('addInv.placeholder.jsonEndpoint')}
                  value={form.priceProviderHistoryUrl}
                  onChange={(e) => setForm(f => ({ ...f, priceProviderHistoryUrl: e.target.value }))}
                  maxLength={500}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-provider-history-path" className="text-xs">{t('addInv.label.historyArrayPath')}</Label>
                <Input
                  id="inv-provider-history-path"
                  placeholder="points"
                  value={form.priceProviderHistoryPath}
                  onChange={(e) => setForm(f => ({ ...f, priceProviderHistoryPath: e.target.value }))}
                  maxLength={300}
                  className="font-mono text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="inv-provider-history-ts" className="text-xs">{t('addInv.label.historyTimestampPath')}</Label>
                  <Input
                    id="inv-provider-history-ts"
                    placeholder="timestamp_ms"
                    value={form.priceProviderHistoryTsPath}
                    onChange={(e) => setForm(f => ({ ...f, priceProviderHistoryTsPath: e.target.value }))}
                    maxLength={300}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="inv-provider-history-price" className="text-xs">{t('addInv.label.historyPricePath')}</Label>
                  <Input
                    id="inv-provider-history-price"
                    placeholder="price"
                    value={form.priceProviderHistoryPricePath}
                    onChange={(e) => setForm(f => ({ ...f, priceProviderHistoryPricePath: e.target.value }))}
                    maxLength={300}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
            </div>
          )}

          {form.priceProvider === 'manual' && (
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
    </>
  );
}
