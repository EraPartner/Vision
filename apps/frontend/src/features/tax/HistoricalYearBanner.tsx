/**
 * HistoricalYearBanner
 *
 * Shown on tax surfaces when the viewed year is not the live profile's active year.
 *
 * Modes (highest priority first — the page picks one):
 *  - `mode="filed"`: the year is marked as filed (ADR-059). Numbers are the frozen
 *    "as-filed" calculation; the banner emphasises the lock and offers unfile.
 *  - `mode="frozen"`: the year has a frozen calculation but is not filed. Numbers reflect
 *    the freeze point; the banner explains engine-drift protection is on.
 *  - `mode="snapshot"`: a frozen profile snapshot exists for `viewedYear`. Banner explains
 *    the numbers are reconstructed live from that snapshot. Action: return to current year.
 *  - `mode="estimate"`: no snapshot for `viewedYear` — numbers are estimated by applying
 *    the live profile to that year's tax tables. Primary action: create a historical
 *    profile snapshot for that year so the user can adjust it. Secondary: back to current.
 */
import { History, Lock, Plus, Snowflake } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type HistoricalYearBannerMode = 'snapshot' | 'estimate' | 'frozen' | 'filed';

interface HistoricalYearBannerProps {
    mode: HistoricalYearBannerMode;
    viewedYear: number;
    currentYear: number;
    onReturnToCurrent: () => void;
    onCreateSnapshot?: () => void;
    /** Used by `filed` mode to show the user-supplied reference (e.g. Tax-on-Web id). */
    filingReference?: string;
}

const MODE_CLASS: Record<HistoricalYearBannerMode, string> = {
    filed: 'border-warning/40 bg-warning/5',
    frozen: 'border-info/40 bg-info/5',
    snapshot: 'border-primary/30 bg-primary/5',
    estimate: 'border-primary/30 bg-primary/5',
};

const MODE_ICON_CLASS: Record<HistoricalYearBannerMode, string> = {
    filed: 'text-warning',
    frozen: 'text-info',
    snapshot: 'text-primary',
    estimate: 'text-primary',
};

export function HistoricalYearBanner({
    mode,
    viewedYear,
    currentYear,
    onReturnToCurrent,
    onCreateSnapshot,
    filingReference,
}: HistoricalYearBannerProps) {
    const { t } = useLanguage();
    const Icon = mode === 'filed' ? Lock : mode === 'frozen' ? Snowflake : History;

    const titleKey = `tax.historical.banner.${mode}Title` as const;
    const descKey = `tax.historical.banner.${mode}Desc` as const;
    const isEstimate = mode === 'estimate';

    return (
        <Alert className={cn(MODE_CLASS[mode])}>
            <Icon className={cn('h-4 w-4', MODE_ICON_CLASS[mode])} />
            <AlertTitle>{t(titleKey, { year: String(viewedYear) })}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground">
                    {t(descKey, { year: String(viewedYear) })}
                    {mode === 'filed' && filingReference && (
                        <span className="ml-1 font-medium text-warning">
                            ({t('tax.historical.banner.filedReferencePrefix')}: {filingReference})
                        </span>
                    )}
                </span>
                <span className="flex items-center gap-2">
                    {isEstimate && onCreateSnapshot && (
                        <Button size="sm" variant="outline" onClick={onCreateSnapshot} className="gap-1">
                            <Plus className="h-3 w-3" />
                            {t('tax.historical.banner.createCta', { year: String(viewedYear) })}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={onReturnToCurrent}>
                        {t('tax.historical.banner.returnCta', { year: String(currentYear) })}
                    </Button>
                </span>
            </AlertDescription>
        </Alert>
    );
}
