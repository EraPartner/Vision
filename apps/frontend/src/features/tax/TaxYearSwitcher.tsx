/**
 * TaxYearSwitcher
 *
 * Header control that lets the user view past income years on the tax surfaces.
 *
 * Behavior:
 *  - Trigger displays the currently-viewed year.
 *  - Items list every year from `useAvailableTaxYears()`, sorted desc, each with
 *    its filed/frozen marker and a status badge.
 *  - Selecting a year sets the provider's `viewedYear` (transient, not persisted).
 *  - When the currently-viewed year has no snapshot AND is not the live year, the
 *    menu surfaces a "Create profile for {year}" footer action that seeds a
 *    snapshot from the live profile so the user can then edit it.
 *
 * A menu rather than a Select because the rows carry badges and the footer
 * carries an action, neither of which a Select can hold.
 */
import { ChevronDown, Plus } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TaxYearStatusIcon } from "./TaxYearStatusIcon";

interface TaxYearSwitcherProps {
    className?: string;
}

export function TaxYearSwitcher({ className }: TaxYearSwitcherProps) {
    const { t } = useLanguage();
    const {
        viewedYear,
        setViewedYear,
        liveYear,
        hasViewedSnapshot,
        createSnapshotFromLive,
    } = useBelgianTaxProfile((state) => ({
        viewedYear: state.viewedYear,
        setViewedYear: state.setViewedYear,
        liveYear: state.profile.taxYear,
        hasViewedSnapshot: Object.prototype.hasOwnProperty.call(
            state.snapshots,
            state.viewedYear,
        ),
        createSnapshotFromLive: state.createSnapshotFromLive,
    }));
    const years = useAvailableTaxYears();

    const canCreateSnapshotForViewed =
        viewedYear !== liveYear && !hasViewedSnapshot;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    className={cn("tabular-nums", className)}
                    aria-label={t("tax.yearSwitcher.trigger")}
                >
                    {t("tax.yearSwitcher.label", { year: String(viewedYear) })}
                    <ChevronDown
                        className="text-label-secondary"
                        aria-hidden="true"
                    />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[240px]">
                <DropdownMenuLabel>
                    {t("tax.yearSwitcher.menuLabel")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {years.map((entry) => {
                    const isActive = entry.year === viewedYear;
                    return (
                        <DropdownMenuItem
                            key={entry.year}
                            onSelect={() => setViewedYear(entry.year)}
                            className="flex items-center justify-between gap-3"
                            aria-current={isActive ? "true" : undefined}
                        >
                            <span className="flex items-center gap-1.5">
                                <span
                                    className={cn(
                                        "tabular-nums",
                                        isActive
                                            ? "font-semibold text-foreground"
                                            : "font-medium",
                                    )}
                                >
                                    {entry.year}
                                </span>
                                <TaxYearStatusIcon
                                    isFiled={entry.isFiled}
                                    hasFrozenCalculation={
                                        entry.hasFrozenCalculation
                                    }
                                    className="h-3 w-3"
                                />
                            </span>
                            <YearStatusBadge entry={entry} />
                        </DropdownMenuItem>
                    );
                })}
                {canCreateSnapshotForViewed && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={() => createSnapshotFromLive(viewedYear)}
                        >
                            <Plus className="mr-2 h-4 w-4 text-label-secondary" />
                            {t("tax.yearSwitcher.createSnapshot", {
                                year: String(viewedYear),
                            })}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

interface YearStatusBadgeProps {
    entry: ReturnType<typeof useAvailableTaxYears>[number];
}

/** One badge per year, by precedence: current > filed > frozen > saved > data only. */
function YearStatusBadge({ entry }: YearStatusBadgeProps) {
    const { t } = useLanguage();
    if (entry.isCurrent) {
        return (
            <Badge variant="default" size="sm">
                {t("tax.yearSwitcher.currentBadge")}
            </Badge>
        );
    }
    if (entry.isFiled) {
        return (
            <Badge variant="warning" size="sm">
                {t("tax.yearSwitcher.filedBadge")}
            </Badge>
        );
    }
    if (entry.hasFrozenCalculation) {
        return (
            <Badge variant="outline" size="sm" className="text-info">
                {t("tax.yearSwitcher.frozenBadge")}
            </Badge>
        );
    }
    if (entry.hasSnapshot) {
        return (
            <Badge variant="secondary" size="sm">
                {t("tax.yearSwitcher.snapshotBadge")}
            </Badge>
        );
    }
    if (entry.hasTransactions) {
        return (
            <Badge variant="muted" size="sm">
                {t("tax.yearSwitcher.transactionsBadge")}
            </Badge>
        );
    }
    return null;
}
