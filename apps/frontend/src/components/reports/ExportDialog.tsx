/**
 * ExportDialog — PDF report export configuration dialog.
 *
 * Lets the user pick report type (financial / portfolio / tax), period,
 * sections, and currency before triggering a server-side PDF download.
 */

import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { DatePicker } from '@/components/shared/DatePicker';
import { parseLocalDateFromYmd, toYmd } from '@/components/shared/dateUtils';
import { todayYmd } from '@/lib/timezone';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { SUPPORTED_CURRENCIES } from '@/utils/currency';
import {
  downloadFinancialReport,
  downloadPortfolioReport,
  downloadTaxReport,
  type ReportPeriod,
} from '@/lib/api/reports';
import {
  SECTIONS_BY_TYPE,
  type ReportType,
  type SectionDef,
} from '@/components/reports/reportSections';

// ─── Constants ───────────────────────────────────────────────────────────────

type PeriodPreset = 'ytd' | 'rolling3' | 'rolling12' | 'year' | 'custom';

// First 12 of the canonical list: EUR..CZK (unchanged dropdown contents).
const CURRENCIES = SUPPORTED_CURRENCIES.slice(0, 12);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPeriod(preset: PeriodPreset, customYear: string, customFrom: string, customTo: string): ReportPeriod {
  switch (preset) {
    case 'ytd':      return { kind: 'ytd' };
    case 'rolling3': return { kind: 'rolling', months: 3 };
    case 'rolling12':return { kind: 'rolling', months: 12 };
    case 'year':     return { kind: 'year', year: parseInt(customYear, 10) || new Date().getFullYear() };
    case 'custom':   return { kind: 'custom', from: customFrom, to: customTo };
  }
}

function allSectionsEnabled(sections: ReadonlySet<string>, defs: SectionDef[]): boolean {
  return defs.every((d) => sections.has(d.id));
}

function defaultSectionSet(defs: SectionDef[]): Set<string> {
  return new Set(defs.map((d) => d.id));
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ExportDialogProps {
  /** Custom trigger element; defaults to an "Export PDF" button. */
  trigger?: React.ReactNode;
  /** Pre-selected report type when the dialog opens. Defaults to 'financial'. */
  defaultType?: ReportType;
}

export function ExportDialog({ trigger, defaultType = 'financial' }: ExportDialogProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const { settings: dashSettings } = useSettings();
  const { profile: taxProfile, calculation: pitCalc } = useBelgianTaxProfile();
  const defaultCurrency = appSettings.defaultCurrency || 'EUR';
  const currentYear = new Date().getFullYear();

  // ── Dialog state
  const [open, setOpen] = useState(false);

  // ── Form state
  const [reportType, setReportType] = useState<ReportType>(defaultType);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('rolling12');
  const [customYear, setCustomYear] = useState(String(currentYear));
  const [customFrom, setCustomFrom] = useState(`${currentYear - 1}-01-01`);
  const [customTo, setCustomTo] = useState(todayYmd());
  const [sections, setSections] = useState<Set<string>>(() => defaultSectionSet(SECTIONS_BY_TYPE[defaultType]));
  const [currency, setCurrency] = useState(defaultCurrency);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const sectionDefs = SECTIONS_BY_TYPE[reportType];

  // Reset sections when report type changes
  function handleReportTypeChange(type: ReportType) {
    setReportType(type);
    setSections(defaultSectionSet(SECTIONS_BY_TYPE[type]));
  }

  function toggleSection(id: string, checked: boolean) {
    setSections((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function toggleAllSections(checked: boolean) {
    setSections(checked ? defaultSectionSet(sectionDefs) : new Set());
  }

  async function handleDownload(e: React.FormEvent) {
    e.preventDefault();
    const period = buildPeriod(periodPreset, customYear, customFrom, customTo);

    // If all sections selected (or none deselected), send empty to use backend defaults.
    const selectedSections = allSectionsEnabled(sections, sectionDefs) ? [] : [...sections];

    const filtersApply = dashSettings.exclusionScope === 'everywhere' || dashSettings.exclusionScope === 'statistics';
    const baseOpts = {
      currency,
      period,
      sections: selectedSections,
      excludedCategoryIds: filtersApply ? [...dashSettings.excludedCategoryIds] : [],
      excludedRecipientIds: filtersApply ? [...dashSettings.excludedRecipientIds] : [],
    };

    setIsSubmitting(true);
    try {
      if (reportType === 'financial') {
        await downloadFinancialReport(baseOpts);
      } else if (reportType === 'portfolio') {
        await downloadPortfolioReport(baseOpts);
      } else {
        const resolvedTaxProfile = taxProfile.profileConfigured
          ? { filingStatus: taxProfile.employmentType, region: taxProfile.region, taxYear: taxProfile.taxYear }
          : undefined;
        const resolvedPIT = taxProfile.profileConfigured
          ? {
              taxableIncome: pitCalc.taxableIncome,
              totalTax: pitCalc.totalPIT,
              brackets: pitCalc.breakdown
                .filter((e) => e.bracket)
                .map((e) => ({ label: e.label, rate: e.rate, taxAmount: e.amount })),
            }
          : undefined;
        await downloadTaxReport({ ...baseOpts, taxProfile: resolvedTaxProfile, precomputedPIT: resolvedPIT });
      }
      toast.success(t('statsPage.report.downloadSuccess'));
      setOpen(false);
    } catch (err: unknown) {
      toast.error(t('statsPage.report.downloadError'), {
        description: apiErrorToMessage(err, t),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const allChecked = allSectionsEnabled(sections, sectionDefs);
  const someChecked = sections.size > 0 && !allChecked;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1.5">
            <FileDown className="h-4 w-4" />
            {t('export.openDialog')}
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('export.title')}</DialogTitle>
          <DialogDescription>{t('export.description')}</DialogDescription>
        </DialogHeader>

        {/* Real <form> so Enter (e.g. in the year field) downloads. grid gap-5
            mirrors DialogContent's layout, so the wrapper is layout-neutral. */}
        <form onSubmit={handleDownload} className="grid gap-5">
        <div className="space-y-6 py-2">

          {/* ── Report type ── */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">{t('export.reportType')}</Label>
            <RadioGroup
              value={reportType}
              onValueChange={(v) => handleReportTypeChange(v as ReportType)}
              className="grid grid-cols-3 gap-2"
            >
              {(['financial', 'portfolio', 'tax'] as const).map((type) => (
                <label
                  key={type}
                  className={
                    'flex items-center gap-2 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors text-sm ' +
                    (reportType === type
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border hover:bg-muted/50 text-muted-foreground')
                  }
                >
                  <RadioGroupItem value={type} />
                  <span className="font-medium">{t(`export.reportType.${type}`)}</span>
                </label>
              ))}
            </RadioGroup>

          </div>

          <Separator />

          {/* ── Period ── */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">{t('export.period')}</Label>
            <RadioGroup
              value={periodPreset}
              onValueChange={(v) => setPeriodPreset(v as PeriodPreset)}
              className="space-y-1.5"
            >
              {(['ytd', 'rolling3', 'rolling12', 'year', 'custom'] as const).map((preset) => (
                <label
                  key={preset}
                  className="flex items-center gap-2.5 cursor-pointer py-1 px-1 rounded hover:bg-muted/40 transition-colors"
                >
                  <RadioGroupItem value={preset} />
                  <span className="text-sm">{t(`export.period.${preset}`)}</span>
                </label>
              ))}
            </RadioGroup>

            {/* Year input */}
            {periodPreset === 'year' && (
              <div className="flex items-center gap-2 pl-1 pt-1">
                <Label htmlFor="export-year" className="text-xs text-muted-foreground w-10 shrink-0">
                  {t('export.period.year.label')}
                </Label>
                <Input
                  id="export-year"
                  type="number"
                  min={2000}
                  max={currentYear + 1}
                  value={customYear}
                  onChange={(e) => setCustomYear(e.target.value)}
                  className="h-8 w-24 text-sm"
                />
              </div>
            )}

            {/* Custom date range */}
            {periodPreset === 'custom' && (
              <div className="grid grid-cols-2 gap-3 pl-1 pt-1">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {t('export.period.from')}
                  </Label>
                  <DatePicker
                    value={customFrom ? parseLocalDateFromYmd(customFrom) : undefined}
                    onChange={(d) => setCustomFrom(d ? toYmd(d) : '')}
                    placeholder={t('export.period.from')}
                    buttonClassName="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {t('export.period.to')}
                  </Label>
                  <DatePicker
                    value={customTo ? parseLocalDateFromYmd(customTo) : undefined}
                    onChange={(d) => setCustomTo(d ? toYmd(d) : '')}
                    placeholder={t('export.period.to')}
                    buttonClassName="h-8 text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* ── Sections ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">{t('export.sections')}</Label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox
                  checked={allChecked || (someChecked ? 'indeterminate' : false)}
                  onCheckedChange={(checked) => toggleAllSections(checked === true)}
                />
                <span className="text-xs text-muted-foreground">{t('export.sections.all')}</span>
              </label>
            </div>

            <div className="space-y-1.5">
              {sectionDefs.map((def) => (
                <label
                  key={def.id}
                  className="flex items-center gap-2.5 cursor-pointer py-1 px-1 rounded hover:bg-muted/40 transition-colors"
                >
                  <Checkbox
                    id={`section-${def.id}`}
                    checked={sections.has(def.id)}
                    onCheckedChange={(checked) => toggleSection(def.id, checked === true)}
                  />
                  <span className="text-sm">{t(def.labelKey)}</span>
                </label>
              ))}
            </div>
          </div>

          <Separator />

          {/* ── Currency ── */}
          <div className="space-y-2">
            <Label htmlFor="export-currency" className="text-sm font-semibold">
              {t('export.currency')}
            </Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="export-currency" className="w-32 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting || sections.size === 0}
            className="gap-1.5"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('export.downloading')}
              </>
            ) : (
              <>
                <FileDown className="h-4 w-4" />
                {t('export.download')}
              </>
            )}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
