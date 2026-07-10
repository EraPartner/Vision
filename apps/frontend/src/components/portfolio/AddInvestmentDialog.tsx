import { useRef, useState } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { deriveUnitMath, parsePositive } from '@/lib/portfolioUnitMath';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Plus, ArrowRight } from 'lucide-react';
import { isUnitBased, isFixedIncome, isRealEstate } from '@/utils/assetClass';
import { usePortfolio } from '@/hooks/usePortfolio';
import type { AssetClass } from '@/types/portfolio';
import { ASSET_CLASS_LABELS, getAssetClassLabel } from '@/types/portfolio';
import type { PriceProvider } from '@/types/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { AssetTypeSelector } from './AssetTypeSelector';
import { InvestmentFormFields } from './InvestmentFormFields';
import type { InvestmentForm } from './InvestmentFormFields';
import { todayYmd } from '@/lib/timezone';

type Props = {
  // when provided, only these asset classes are shown; if exactly one is provided
  // the dialog will open directly to the details form for that class
  allowedAssetClasses?: AssetClass[];
};

const PRICE_PROVIDERS = (t: (k: string) => string) => [
  { key: 'manual' as PriceProvider, name: t('addInv.provider.manual'), hint: t('addInv.provider.hint.manual') },
  { key: 'binance' as PriceProvider, name: 'Binance', hint: t('addInv.provider.hint.binance') },
  { key: 'yahoo' as PriceProvider, name: 'Yahoo Finance', hint: t('addInv.provider.hint.yahoo') },
  { key: 'kinesis' as PriceProvider, name: 'Kinesis', hint: t('addInv.provider.hint.kinesis') },
  { key: 'custom' as PriceProvider, name: 'Custom JSON', hint: t('addInv.provider.hint.custom') },
];

function makeEmptyForm(defaultCurrency: string): InvestmentForm {
  return {
    assetClass: '', name: '', symbol: '', currency: defaultCurrency, currentPrice: '',
    interestRate: '', maturityDate: '', location: '', municipality: '', cadastralIncome: '',
    municipalityTaxRate: '', notes: '', priceProvider: 'manual', priceProviderId: '',
    priceProviderUrl: '', priceProviderLatestUrl: '', priceProviderLatestPath: '',
    priceProviderHistoryUrl: '', priceProviderHistoryPath: 'points',
    priceProviderHistoryTsPath: 'timestamp_ms', priceProviderHistoryPricePath: 'price',
    addInitialPurchase: true, initialAmount: '', initialUnits: '',
    initialDate: todayYmd(), initialFees: '',
  };
}

export function AddInvestmentDialog({ allowedAssetClasses }: Props) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const defaultCurrency = appSettings.defaultCurrency || 'EUR';
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'type' | 'details'>('type');
  const { addInvestment, addTransaction } = usePortfolio();
  const [form, setForm] = useState<InvestmentForm>(() => makeEmptyForm(defaultCurrency));
  // Set once the investment row exists so a retry after a failed buy leg
  // re-attempts only the transaction instead of creating a duplicate holding.
  const createdInvestmentIdRef = useRef<number | null>(null);

  const assetDescriptions: Record<AssetClass, string> = {
    stock: t('addInv.desc.stock'),
    etf: t('addInv.desc.etf'),
    crypto: t('addInv.desc.crypto'),
    metals: t('addInv.desc.metals'),
    real_estate: t('addInv.desc.real_estate'),
    savings: t('addInv.desc.savings'),
    bond: t('addInv.desc.bond'),
  };

  const priceProviders = PRICE_PROVIDERS(t);

  const unitBased = isUnitBased(form.assetClass as AssetClass);
  const fixedIncome = isFixedIncome(form.assetClass as AssetClass);
  const realEstate = isRealEstate(form.assetClass as AssetClass);
  const selectedProvider = priceProviders.find(p => p.key === form.priceProvider);
  const computedInitialUnits = parseDecimal(form.initialUnits);
  const computedPricePerUnit = form.initialAmount && computedInitialUnits > 0
    ? (parseDecimal(form.initialAmount) / computedInitialUnits).toFixed(4)
    : '';

  const reset = () => {
    setForm(makeEmptyForm(defaultCurrency));
    createdInvestmentIdRef.current = null;
    setStep('type');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.assetClass || !form.name.trim()) return;

    // Validate the initial purchase BEFORE creating the investment. The old
    // flow created the row first, then either silently skipped the buy (empty
    // amount → holding with no purchase behind a success toast) or hit a
    // guaranteed backend 400 (unit-based without units, cleared date) with
    // the investment already committed.
    let initialBuy: { amount: number; units?: number; price_per_unit?: number } | null = null;
    if (form.addInitialPurchase) {
      if (!form.initialDate) {
        toast.error(t('addPortTxn.error.dateRequired'));
        return;
      }
      const amount = parsePositive(form.initialAmount);
      const units = parsePositive(form.initialUnits);
      if (unitBased) {
        const math = deriveUnitMath({ amount, units });
        if (!math.isConsistent || math.effectiveAmount === undefined) {
          toast.error(t('addPortTxn.error.twoOfThreeRequired'));
          return;
        }
        initialBuy = {
          amount: math.effectiveAmount,
          units: math.effectiveUnits,
          price_per_unit: math.effectivePrice,
        };
      } else if (amount === undefined) {
        toast.error(t('addPortTxn.error.amountRequired'));
        return;
      } else {
        initialBuy = { amount, units };
      }
    }

    try {
      let investmentId = createdInvestmentIdRef.current;
      if (investmentId == null) {
        const investment = await addInvestment({
          name: form.name.trim(),
          symbol: form.symbol.trim() || undefined,
          asset_class: form.assetClass as AssetClass,
          currency: form.currency || defaultCurrency,
          current_price: form.currentPrice ? parseDecimal(form.currentPrice) : undefined,
          interest_rate: form.interestRate ? parseDecimal(form.interestRate) : undefined,
          maturity_date: form.maturityDate || undefined,
          location: form.location.trim() || undefined,
          municipality: form.municipality.trim() || undefined,
          cadastral_income: form.cadastralIncome ? parseDecimal(form.cadastralIncome) : undefined,
          municipality_tax_rate: form.municipalityTaxRate ? parseDecimal(form.municipalityTaxRate) : undefined,
          notes: form.notes.trim() || undefined,
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
        if (!investment) return;
        investmentId = investment.id;
        createdInvestmentIdRef.current = investmentId;
      }

      if (initialBuy) {
        await addTransaction({
          investmentId,
          type: 'buy',
          date: form.initialDate,
          amount: initialBuy.amount,
          units: initialBuy.units,
          price_per_unit: initialBuy.price_per_unit,
          fees: form.initialFees ? parseDecimal(form.initialFees) : undefined,
          currency: form.currency || defaultCurrency,
          note: t('addInv.initialPurchaseNote'),
        });
      }

      toast.success(t('addInv.toast.added', { assetClass: getAssetClassLabel(t, form.assetClass as AssetClass), name: form.name }));
      reset();
      setOpen(false);
    } catch {
      // error toast shown by the hook; the dialog stays open and a resubmit
      // reuses createdInvestmentIdRef instead of duplicating the holding
    }
  };

  const visibleAssetClasses = (allowedAssetClasses && allowedAssetClasses.length > 0)
    ? allowedAssetClasses
    : (Object.keys(ASSET_CLASS_LABELS) as AssetClass[]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) { reset(); return; }
        reset();
        if (allowedAssetClasses && allowedAssetClasses.length === 1) {
          const key = allowedAssetClasses[0];
          const defaultProvider = key === 'crypto' ? 'binance' : ['stock', 'etf', 'metals'].includes(key) ? 'yahoo' : 'manual';
          setForm(f => ({ ...f, assetClass: key, priceProvider: defaultProvider as PriceProvider }));
          setStep('details');
        } else {
          setStep('type');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" /> {t('addInv.title')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'type'
              ? t('addInv.chooseType')
              : t('addInv.assetTitle', { assetClass: form.assetClass ? getAssetClassLabel(t, form.assetClass as AssetClass) : t('addInv.title') })}
          </DialogTitle>
          {step === 'type' ? (
            <DialogDescription>{t('addInv.chooseTypeDesc')}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{t('addInv.title')}</DialogDescription>
          )}
        </DialogHeader>

        {step === 'type' ? (
          <AssetTypeSelector
            visibleAssetClasses={visibleAssetClasses}
            assetDescriptions={assetDescriptions}
            onSelect={(key, defaultProvider) => {
              setForm(f => ({ ...f, assetClass: key, priceProvider: defaultProvider }));
              setStep('details');
            }}
            t={t}
          />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <InvestmentFormFields
              form={form}
              setForm={setForm}
              isUnitBased={unitBased}
              isFixedIncome={fixedIncome}
              isRealEstate={realEstate}
              computedPricePerUnit={computedPricePerUnit}
              priceProviders={priceProviders}
              selectedProvider={selectedProvider}
              t={t}
            />
            <DialogFooter className="pt-2 sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setStep('type')}>{t('addInv.back')}</Button>
              <Button type="submit" className="gap-1.5">
                {t('addInv.create')} <ArrowRight className="h-4 w-4" />
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
