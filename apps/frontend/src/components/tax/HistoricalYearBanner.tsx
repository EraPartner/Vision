/**
 * HistoricalYearBanner
 *
 * Shown on tax surfaces when the viewed year is not the live profile's active year.
 *
 * Two modes:
 *  - `mode="snapshot"`: a frozen snapshot exists for `viewedYear`. Banner explains the
 *    numbers are reconstructed from that snapshot. Action: return to current year.
 *  - `mode="estimate"`: no snapshot for `viewedYear` — numbers are estimated by applying
 *    the live profile to that year's tax tables. Primary action: create a historical
 *    profile snapshot for that year so the user can adjust it. Secondary: back to current.
 */
import { History, Plus } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export type HistoricalYearBannerMode = 'snapshot' | 'estimate';

interface HistoricalYearBannerProps {
    mode: HistoricalYearBannerMode;
    viewedYear: number;
    currentYear: number;
    onReturnToCurrent: () => void;
    onCreateSnapshot?: () => void;
}

export function HistoricalYearBanner({
    mode,
    viewedYear,
    currentYear,
    onReturnToCurrent,
    onCreateSnapshot,
}: HistoricalYearBannerProps) {
    const { t } = useLanguage();
    const isSnapshot = mode === 'snapshot';
    const titleKey = isSnapshot
        ? 'tax.historical.banner.snapshotTitle'
        : 'tax.historical.banner.estimateTitle';
    const descKey = isSnapshot
        ? 'tax.historical.banner.snapshotDesc'
        : 'tax.historical.banner.estimateDesc';

    return (
        <Alert className="border-primary/30 bg-primary/5">
            <History className="h-4 w-4 text-primary" />
            <AlertTitle>{t(titleKey, { year: String(viewedYear) })}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground">
                    {t(descKey, { year: String(viewedYear) })}
                </span>
                <span className="flex items-center gap-2">
                    {!isSnapshot && onCreateSnapshot && (
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
