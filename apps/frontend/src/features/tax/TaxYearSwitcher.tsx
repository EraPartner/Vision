/**
 * TaxYearSwitcher
 *
 * Dropdown that lets the user view past income years on the tax overview surfaces.
 *
 * Behavior:
 *  - Trigger displays the currently-viewed year, styled like the original year badge.
 *  - Items list every year from `useAvailableTaxYears()`, sorted desc.
 *  - Selecting a year sets the provider's `viewedYear` (transient, not persisted).
 *  - When the currently-viewed year has no snapshot AND is not the live year, the menu
 *    surfaces a "Create historical profile for {year}" footer action that seeds a snapshot
 *    from the live profile so the user can then edit it via the profile dialog.
 */
import { ChevronDown, History, Lock, Plus, Snowflake, Sparkles, Wallet } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { useAvailableTaxYears } from '@/hooks/useAvailableTaxYears';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TaxYearSwitcherProps {
    className?: string;
}

export function TaxYearSwitcher({ className }: TaxYearSwitcherProps) {
    const { t } = useLanguage();
    const {
        viewedYear,
        setViewedYear,
        profile,
        snapshotExistsForYear,
        createSnapshotFromLive,
    } = useBelgianTaxProfile();
    const years = useAvailableTaxYears();

    const canCreateSnapshotForViewed =
        viewedYear !== profile.taxYear && !snapshotExistsForYear(viewedYear);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2.5 py-1 text-xs font-medium text-secondary-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        className,
                    )}
                    aria-label={t('tax.yearSwitcher.trigger')}
                >
                    <History className="h-3 w-3 text-muted-foreground" />
                    <span>{t('tax.yearSwitcher.label', { year: String(viewedYear) })}</span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {t('tax.yearSwitcher.menuLabel')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {years.map((entry) => {
                    const isActive = entry.year === viewedYear;
                    return (
                        <DropdownMenuItem
                            key={entry.year}
                            onSelect={() => setViewedYear(entry.year)}
                            className={cn(
                                'flex items-center justify-between gap-2',
                                isActive && 'bg-accent/60',
                            )}
                        >
                            <span className="flex items-center gap-1.5">
                                <span className="font-medium tabular-nums">{entry.year}</span>
                                {entry.isFiled && (
                                    <Lock
                                        className="h-3 w-3 text-warning"
                                        aria-label={t('tax.yearSwitcher.filedAria')}
                                    />
                                )}
                                {!entry.isFiled && entry.hasFrozenCalculation && (
                                    <Snowflake
                                        className="h-3 w-3 text-sky-600"
                                        aria-label={t('tax.yearSwitcher.frozenAria')}
                                    />
                                )}
                            </span>
                            <span className="flex items-center gap-1">
                                {entry.isCurrent && (
                                    <Badge variant="default" className="h-4 px-1.5 text-[10px]">
                                        <Sparkles className="mr-0.5 h-2.5 w-2.5" />
                                        {t('tax.yearSwitcher.currentBadge')}
                                    </Badge>
                                )}
                                {!entry.isCurrent && entry.isFiled && (
                                    <Badge
                                        variant="outline"
                                        className="h-4 px-1.5 text-[10px] border-warning/40 text-warning"
                                    >
                                        {t('tax.yearSwitcher.filedBadge')}
                                    </Badge>
                                )}
                                {!entry.isCurrent && !entry.isFiled && entry.hasFrozenCalculation && (
                                    <Badge
                                        variant="outline"
                                        className="h-4 px-1.5 text-[10px] border-sky-500/40 text-sky-700"
                                    >
                                        {t('tax.yearSwitcher.frozenBadge')}
                                    </Badge>
                                )}
                                {!entry.isCurrent &&
                                    !entry.isFiled &&
                                    !entry.hasFrozenCalculation &&
                                    entry.hasSnapshot && (
                                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                                            {t('tax.yearSwitcher.snapshotBadge')}
                                        </Badge>
                                    )}
                                {!entry.isCurrent &&
                                    !entry.hasSnapshot &&
                                    entry.hasTransactions && (
                                        <Badge
                                            variant="outline"
                                            className="h-4 px-1.5 text-[10px] text-muted-foreground"
                                        >
                                            <Wallet className="mr-0.5 h-2.5 w-2.5" />
                                            {t('tax.yearSwitcher.transactionsBadge')}
                                        </Badge>
                                    )}
                            </span>
                        </DropdownMenuItem>
                    );
                })}
                {canCreateSnapshotForViewed && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={() => createSnapshotFromLive(viewedYear)}
                            className="text-primary"
                        >
                            <Plus className="mr-2 h-3.5 w-3.5" />
                            {t('tax.yearSwitcher.createSnapshot', { year: String(viewedYear) })}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
