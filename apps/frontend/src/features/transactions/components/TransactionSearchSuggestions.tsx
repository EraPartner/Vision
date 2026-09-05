import { useState } from "react";
import {
    ArrowLeft, CalendarRange, CalendarDays, Coins, Search,
    TrendingDown, TrendingUp,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/lib/dateUtils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";

/** URL-param patch applied by a quick filter. `undefined` clears the key. */
export type QuickFilterParams = Record<string, string | undefined>;

interface Props {
    /** Live free-text query (informational — typing already drives free search). */
    query: string;
    /** Merge these URL params into the active filter set. */
    onApply: (params: QuickFilterParams) => void;
    /** Dismiss the dropdown. */
    close: () => void;
}

type Mode = null | 'amountExact' | 'amountRange' | 'year' | 'dateRange';

function SuggestionRow({
    icon: Icon, label, onClick,
}: { icon: typeof Search; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
        >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
        </button>
    );
}

export function TransactionSearchSuggestions({ query, onApply, close }: Props) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const currency = appSettings.defaultCurrency || 'EUR';
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;

    const [mode, setMode] = useState<Mode>(null);
    const [amountA, setAmountA] = useState('');
    const [amountB, setAmountB] = useState('');
    const [yearInput, setYearInput] = useState(String(thisYear));
    const [dateStart, setDateStart] = useState<string | undefined>(undefined);
    const [dateEnd, setDateEnd] = useState<string | undefined>(undefined);

    const apply = (params: QuickFilterParams) => { onApply(params); close(); };
    const yearRange = (y: number): QuickFilterParams => ({ start_date: `${y}-01-01`, end_date: `${y}-12-31` });

    // A leading + or - makes the amount sign-aware (exact signed match); a bare
    // number matches the magnitude (both signs). type=text (not number) so the
    // sign character survives to be read here.
    const parseSigned = (raw: string): { value: number; signed: boolean } | undefined => {
        const s = raw.trim();
        if (s === '') return undefined;
        const signed = s.startsWith('+') || s.startsWith('-');
        const v = Number(s);
        return Number.isFinite(v) ? { value: v, signed } : undefined;
    };

    const container = "rounded-lg border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden";

    if (mode === 'amountExact' || mode === 'amountRange') {
        const isRange = mode === 'amountRange';
        const pa = parseSigned(amountA);
        const pb = parseSigned(amountB);
        const valid = isRange ? (pa !== undefined || pb !== undefined) : pa !== undefined;
        const signed = !!(pa?.signed || pb?.signed);
        const conv = (p?: { value: number }) => (p === undefined ? undefined : (signed ? p.value : Math.abs(p.value)));
        const onApplyAmount = () => {
            if (!valid) return;
            const signedParam = signed ? 'true' : undefined;
            if (isRange) {
                let lo = conv(pa);
                let hi = conv(pb);
                if (lo !== undefined && hi !== undefined && lo > hi) [lo, hi] = [hi, lo];
                apply({
                    amount_min: lo !== undefined ? String(lo) : undefined,
                    amount_max: hi !== undefined ? String(hi) : undefined,
                    amount_signed: signedParam,
                });
            } else {
                // "equals" is a zero-width range (min === max).
                const v = conv(pa) as number;
                apply({ amount_min: String(v), amount_max: String(v), amount_signed: signedParam });
            }
        };
        return (
            <div className={container}>
                <FormHeader label={isRange ? t('search.suggest.amountRange.title', { currency }) : t('search.suggest.amountExact.title', { currency })} onBack={() => setMode(null)} backLabel={t('common.back')} />
                <div className="flex items-center gap-2 px-3 pt-3">
                    <Input
                        type="text" inputMode="text" autoFocus
                        placeholder={isRange ? t('search.suggest.amount.min') : currency}
                        value={amountA} onChange={(e) => setAmountA(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') onApplyAmount(); }}
                        className="h-9"
                    />
                    {isRange && (
                        <>
                            <span className="text-muted-foreground text-sm">–</span>
                            <Input
                                type="text" inputMode="text"
                                placeholder={t('search.suggest.amount.max')}
                                value={amountB} onChange={(e) => setAmountB(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') onApplyAmount(); }}
                                className="h-9"
                            />
                        </>
                    )}
                    <Button size="sm" className="h-9 shrink-0" disabled={!valid} onClick={onApplyAmount}>
                        {t('search.suggest.apply')}
                    </Button>
                </div>
                <p className="px-3 pb-2.5 pt-1.5 text-xs text-muted-foreground">{t('search.suggest.amount.hint')}</p>
            </div>
        );
    }

    if (mode === 'year') {
        const y = Number(yearInput);
        const valid = /^\d{4}$/.test(yearInput.trim()) && y >= 1900 && y <= 2999;
        const onApplyYear = () => { if (valid) apply(yearRange(y)); };
        return (
            <div className={container}>
                <FormHeader label={t('search.suggest.year.title')} onBack={() => setMode(null)} backLabel={t('common.back')} />
                <div className="flex items-center gap-2 p-3">
                    <Input
                        type="number" inputMode="numeric" autoFocus
                        placeholder="2026"
                        value={yearInput} onChange={(e) => setYearInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') onApplyYear(); }}
                        className="h-9"
                    />
                    <Button size="sm" className="h-9 shrink-0" disabled={!valid} onClick={onApplyYear}>
                        {t('search.suggest.apply')}
                    </Button>
                </div>
            </div>
        );
    }

    if (mode === 'dateRange') {
        const valid = !!dateStart || !!dateEnd;
        const onApplyDates = () => {
            if (!valid) return;
            apply({ start_date: dateStart, end_date: dateEnd });
        };
        return (
            <div className={container}>
                <FormHeader label={t('search.suggest.dateRange.title')} onBack={() => setMode(null)} backLabel={t('common.back')} />
                <div className="flex flex-wrap items-center gap-2 p-3">
                    <DatePicker
                        value={dateStart ? parseLocalDateFromYmd(dateStart) : undefined}
                        onChange={(d) => setDateStart(d ? toYmd(d) : undefined)}
                        placeholder={t('search.suggest.date.from')}
                        allowClear
                    />
                    <span className="text-muted-foreground text-sm">→</span>
                    <DatePicker
                        value={dateEnd ? parseLocalDateFromYmd(dateEnd) : undefined}
                        onChange={(d) => setDateEnd(d ? toYmd(d) : undefined)}
                        placeholder={t('search.suggest.date.to')}
                        allowClear
                    />
                    <Button size="sm" className="h-9 shrink-0 ml-auto" disabled={!valid} onClick={onApplyDates}>
                        {t('search.suggest.apply')}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className={container}>
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border/60">
                {t('search.suggest.header')}
            </div>
            <div className="max-h-[60vh] overflow-y-auto py-1">
                <SuggestionRow icon={TrendingUp} label={t('search.suggest.allIncome')} onClick={() => apply({ transaction_type: 'income' })} />
                <SuggestionRow icon={TrendingDown} label={t('search.suggest.allExpense')} onClick={() => apply({ transaction_type: 'expense' })} />
                <SuggestionRow icon={Coins} label={t('search.suggest.amountExact', { currency })} onClick={() => setMode('amountExact')} />
                <SuggestionRow icon={Coins} label={t('search.suggest.amountRange', { currency })} onClick={() => setMode('amountRange')} />
                <SuggestionRow icon={CalendarDays} label={t('search.suggest.ofYear', { year: thisYear })} onClick={() => apply(yearRange(thisYear))} />
                <SuggestionRow icon={CalendarDays} label={t('search.suggest.ofYear', { year: lastYear })} onClick={() => apply(yearRange(lastYear))} />
                <SuggestionRow icon={CalendarDays} label={t('search.suggest.year')} onClick={() => setMode('year')} />
                <SuggestionRow icon={CalendarRange} label={t('search.suggest.dateRange')} onClick={() => setMode('dateRange')} />
                <SuggestionRow
                    icon={Search}
                    label={query.trim() ? t('search.suggest.freeSearchFor', { query: query.trim() }) : t('search.suggest.freeSearch')}
                    onClick={close}
                />
            </div>
        </div>
    );
}

function FormHeader({ label, onBack, backLabel }: { label: string; onBack: () => void; backLabel: string }) {
    return (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/60">
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onBack} aria-label={backLabel}>
                <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
        </div>
    );
}
