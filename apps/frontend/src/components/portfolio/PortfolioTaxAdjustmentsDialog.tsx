import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { numberFormatToLocale } from '@/utils/currency';
import { usePortfolioTaxAdjustments } from '@/hooks/usePortfolioTaxAdjustments';
import { getAssetClassLabel, type InvestmentSummary } from '@/types/portfolio';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  investments: InvestmentSummary[];
}

export function PortfolioTaxAdjustmentsDialog({ investments }: Props) {
  const { t } = useLanguage();
  const { profile } = useBelgianTaxProfile();
  const { appSettings } = useAppSettings();
  const { getAdjustment, saveManyForYear, isLoading } = usePortfolioTaxAdjustments();
  const [open, setOpen] = useState(false);

  const locale = numberFormatToLocale(appSettings.numberFormat);
  const sorted = useMemo(() => [...investments].sort((a, b) => a.name.localeCompare(b.name)), [investments]);

  const [draft, setDraft] = useState<Record<number, { taxes: string; fees: string }>>({});

  useEffect(() => {
    if (!open) return;
    const next: Record<number, { taxes: string; fees: string }> = {};
    sorted.forEach((inv) => {
      const current = getAdjustment(profile.taxYear, inv.id);
      next[inv.id] = {
        taxes: current.taxes ? String(current.taxes) : '',
        fees: current.fees ? String(current.fees) : '',
      };
    });
    setDraft(next);
  }, [open, sorted, getAdjustment, profile.taxYear]);

  const parseNumber = (v?: string) => {
    const normalized = (v ?? '').replace(',', '.').trim();
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : 0;
  };

  const draftTotals = useMemo(() => {
    return sorted.reduce(
      (acc, inv) => {
        const row = draft[inv.id];
        acc.taxes += parseNumber(row?.taxes);
        acc.fees += parseNumber(row?.fees);
        return acc;
      },
      { taxes: 0, fees: 0 },
    );
  }, [sorted, draft]);

  const fmt = (val: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: appSettings.defaultCurrency || 'EUR',
      minimumFractionDigits: appSettings.showDecimalPlaces,
      maximumFractionDigits: appSettings.showDecimalPlaces,
    }).format(val);

  async function handleSave() {
    const payload: Record<number, { taxes: number; fees: number }> = {};
    sorted.forEach((inv) => {
      const row = draft[inv.id];
      payload[inv.id] = {
        taxes: parseNumber(row?.taxes),
        fees: parseNumber(row?.fees),
      };
    });
    try {
      await saveManyForYear(profile.taxYear, payload);
      toast.success(t('tax.manualAdjustmentsSaved'));
      setOpen(false);
    } catch (err) {
      toast.error(t('tax.manualAdjustmentsSaveFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={isLoading}>
          <SlidersHorizontal className="h-4 w-4" />
          {t('tax.manualAdjustments')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('tax.manualAdjustmentsTitle', { year: String(profile.taxYear) })}</DialogTitle>
          <DialogDescription>{t('tax.manualAdjustmentsDesc')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t('tax.totalTaxesPaid')}</p>
            <p className="text-lg font-bold tabular-nums text-destructive">{fmt(draftTotals.taxes)}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t('tax.totalFeesPaid')}</p>
            <p className="text-lg font-bold tabular-nums text-destructive">{fmt(draftTotals.fees)}</p>
          </div>
        </div>

        <Separator />

        <div className="max-h-[52vh] overflow-y-auto space-y-2 pr-1">
          {sorted.map((inv) => (
            <div key={inv.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                {inv.symbol && <span className="font-mono text-xs font-semibold">{inv.symbol}</span>}
                <span className="text-sm font-medium">{inv.name}</span>
                <Badge variant="secondary" className="text-[10px]">{getAssetClassLabel(t, inv.assetClass)}</Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t('tax.taxes')}</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={draft[inv.id]?.taxes ?? ''}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        [inv.id]: { ...(prev[inv.id] ?? { taxes: '', fees: '' }), taxes: e.target.value },
                      }))
                    }
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('tax.fees')}</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={draft[inv.id]?.fees ?? ''}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        [inv.id]: { ...(prev[inv.id] ?? { taxes: '', fees: '' }), fees: e.target.value },
                      }))
                    }
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
