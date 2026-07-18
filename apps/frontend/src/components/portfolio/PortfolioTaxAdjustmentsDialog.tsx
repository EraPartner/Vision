import { useEffect, useMemo, useState } from 'react';
import { parseDecimal } from '@/lib/decimal';
import { useLanguage } from '@/contexts/LanguageContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { usePortfolioTaxAdjustments } from '@/hooks/usePortfolioTaxAdjustments';
import { usePortfolioTaxClassifications, type EtfStructure, type TaxClassificationEntry } from '@/hooks/usePortfolioTaxClassifications';
import { getAssetClassLabel, type InvestmentSummary } from '@/types/portfolio';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';

type ReyndersChoice = 'auto' | 'yes' | 'no';

function reyndersFromChoice(v: ReyndersChoice): boolean | undefined {
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return undefined;
}

function choiceFromReynders(v: boolean | undefined): ReyndersChoice {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'auto';
}

interface Props {
  investments: InvestmentSummary[];
}

export function PortfolioTaxAdjustmentsDialog({ investments }: Props) {
  const { t } = useLanguage();
  const { profile } = useBelgianTaxProfile();
  const { getAdjustment, saveManyForYear, isLoading } = usePortfolioTaxAdjustments();
  const { getClassification, setMany: setClassifications, isLoading: classificationsLoading } = usePortfolioTaxClassifications();
  const [open, setOpen] = useState(false);

  const sorted = useMemo(() => [...investments].sort((a, b) => a.name.localeCompare(b.name)), [investments]);

  type ClassDraftRow = {
    etfStructure?: EtfStructure;
    reynders: ReyndersChoice;
    interestPortion: string;
  };

  const [draft, setDraft] = useState<Record<number, { taxes: string; fees: string }>>({});
  const [classDraft, setClassDraft] = useState<Record<number, ClassDraftRow>>({});

  useEffect(() => {
    if (!open) return;
    const next: Record<number, { taxes: string; fees: string }> = {};
    const nextClass: Record<number, ClassDraftRow> = {};
    sorted.forEach((inv) => {
      const current = getAdjustment(profile.taxYear, inv.id);
      next[inv.id] = {
        taxes: current.taxes ? String(current.taxes) : '',
        fees: current.fees ? String(current.fees) : '',
      };
      const cls = getClassification(inv.id);
      nextClass[inv.id] = {
        etfStructure: cls.etfStructure,
        reynders: choiceFromReynders(cls.subjectToReynders),
        interestPortion:
          typeof cls.reyndersInterestPortion === 'number'
            ? String(Math.round(cls.reyndersInterestPortion * 100))
            : '',
      };
    });
    setDraft(next);
    setClassDraft(nextClass);
  }, [open, sorted, getAdjustment, getClassification, profile.taxYear]);

  const parseNumber = (v?: string) => parseDecimal(v, 0);

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

  // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
  const fmt = useCurrencyFormatter();

  async function handleSave() {
    const payload: Record<number, { taxes: number; fees: number }> = {};
    const classPayload: Record<number, TaxClassificationEntry> = {};
    sorted.forEach((inv) => {
      const row = draft[inv.id];
      payload[inv.id] = {
        taxes: parseNumber(row?.taxes),
        fees: parseNumber(row?.fees),
      };
      const cls = classDraft[inv.id];
      if (cls) {
        const portionPct = parseNumber(cls.interestPortion);
        const portion = portionPct > 0 && portionPct <= 100 ? portionPct / 100 : undefined;
        classPayload[inv.id] = {
          etfStructure: cls.etfStructure,
          subjectToReynders: reyndersFromChoice(cls.reynders),
          reyndersInterestPortion: portion,
        };
      }
    });
    try {
      await Promise.all([
        saveManyForYear(profile.taxYear, payload),
        setClassifications(classPayload),
      ]);
      toast.success(t('tax.manualAdjustmentsSaved'));
      setOpen(false);
    } catch {
      toast.error(t('tax.manualAdjustmentsSaveFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={isLoading || classificationsLoading}>
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
          {sorted.map((inv) => {
            const showEtfStructure = inv.assetClass === 'etf';
            const showReynders = inv.assetClass === 'etf' || inv.assetClass === 'bond';
            const cls: ClassDraftRow = classDraft[inv.id] ?? {
              reynders: 'auto',
              interestPortion: '',
            };
            const reyndersResolved =
              cls.reynders === 'yes' || (cls.reynders === 'auto' && inv.assetClass === 'bond');
            return (
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
              {(showEtfStructure || showReynders) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pt-3 border-t border-dashed border-border">
                  {showEtfStructure && (
                    <div className="space-y-1">
                      <Label className="text-xs">{t('tax.etfStructure')}</Label>
                      <Select
                        value={cls.etfStructure ?? 'accumulating'}
                        onValueChange={(v) =>
                          setClassDraft((prev) => ({
                            ...prev,
                            [inv.id]: { ...(prev[inv.id] ?? { reynders: 'auto' }), etfStructure: v as EtfStructure },
                          }))
                        }
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="accumulating">{t('tax.etfStructure.accumulating')}</SelectItem>
                          <SelectItem value="distributing">{t('tax.etfStructure.distributing')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">{t('tax.etfStructure.desc')}</p>
                    </div>
                  )}
                  {showReynders && (
                    <div className="space-y-1">
                      <Label className="text-xs">{t('tax.subjectToReynders')}</Label>
                      <Select
                        value={cls.reynders}
                        onValueChange={(v) =>
                          setClassDraft((prev) => ({
                            ...prev,
                            [inv.id]: {
                              ...(prev[inv.id] ?? { reynders: 'auto', interestPortion: '' }),
                              reynders: v as ReyndersChoice,
                            },
                          }))
                        }
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">{t('tax.subjectToReynders.auto')}</SelectItem>
                          <SelectItem value="yes">{t('tax.subjectToReynders.yes')}</SelectItem>
                          <SelectItem value="no">{t('tax.subjectToReynders.no')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">{t('tax.subjectToReynders.desc')}</p>
                    </div>
                  )}
                  {showReynders && reyndersResolved && (
                    <div className="space-y-1 md:col-span-2">
                      <Label className="text-xs">{t('tax.reyndersInterestPortion')}</Label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={100}
                        step={1}
                        value={cls.interestPortion}
                        onChange={(e) =>
                          setClassDraft((prev) => ({
                            ...prev,
                            [inv.id]: {
                              ...(prev[inv.id] ?? { reynders: 'auto', interestPortion: '' }),
                              interestPortion: e.target.value,
                            },
                          }))
                        }
                        placeholder="100"
                      />
                      <p className="text-[11px] text-muted-foreground">{t('tax.reyndersInterestPortion.desc')}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
          })}
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
