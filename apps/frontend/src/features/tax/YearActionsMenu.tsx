/**
 * YearActionsMenu
 *
 * Dropdown surfacing the per-year actions added by ADR-059: freeze/unfreeze the
 * calculation, mark as filed / unmark, view audit history, and export the year as CSV.
 *
 * Wired against the currently-viewed year. The page mounts one of these alongside the
 * `TaxYearSwitcher` so all year-scoped operations live in a predictable spot.
 */
import {
    MoreHorizontal,
    Snowflake,
    Lock,
    History,
    FileDown,
    Unlock,
} from "lucide-react";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkAsFiledDialog } from "./MarkAsFiledDialog";
import { SnapshotHistoryDialog } from "./SnapshotHistoryDialog";
import { exportTaxYearCsv } from "@/lib/belgianTax/exportTaxYearCsv";
import { useAppSettings } from "@/contexts/AppSettingsContext";

interface YearActionsMenuProps {
    /** The year the menu operates on. Typically the page's `viewedYear`. */
    year: number;
}

export function YearActionsMenu({ year }: YearActionsMenuProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const {
        profile,
        snapshotExistsForYear,
        profileForYear,
        displayCalculationForYear,
        getFrozenCalculation,
        isYearFiled,
        freezeCalculation,
        unfreezeCalculation,
        unmarkYearAsFiled,
    } = useBelgianTaxProfile();

    const filed = isYearFiled(year);
    const hasFrozen = getFrozenCalculation(year) != null;
    const liveYear = profile.taxYear;

    function handleExport() {
        exportTaxYearCsv({
            year,
            profile: profileForYear(year),
            calculation: displayCalculationForYear(year),
            currency: appSettings.defaultCurrency || "EUR",
            isFiled: filed,
            hasFrozenCalculation: hasFrozen,
            // Friendly stamp for the file header.
            generatedAt: new Date().toISOString(),
        });
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    aria-label={t("tax.yearActions.trigger", {
                        year: String(year),
                    })}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {t("tax.yearActions.menuLabel", { year: String(year) })}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />

                {!filed && !hasFrozen && (
                    <DropdownMenuItem
                        onSelect={() => freezeCalculation(year)}
                        className="gap-2"
                    >
                        <Snowflake className="h-3.5 w-3.5 text-info" />
                        {t("tax.yearActions.freeze")}
                    </DropdownMenuItem>
                )}
                {!filed && hasFrozen && (
                    <DropdownMenuItem
                        onSelect={() => unfreezeCalculation(year)}
                        className="gap-2"
                    >
                        <Snowflake className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("tax.yearActions.unfreeze")}
                    </DropdownMenuItem>
                )}

                {!filed && year !== liveYear && (
                    <MarkAsFiledDialog
                        year={year}
                        trigger={
                            <DropdownMenuItem
                                onSelect={(e) => e.preventDefault()}
                                className="gap-2"
                            >
                                <Lock className="h-3.5 w-3.5 text-warning" />
                                {t("tax.yearActions.markFiled")}
                            </DropdownMenuItem>
                        }
                    />
                )}
                {filed && (
                    <DropdownMenuItem
                        onSelect={() => unmarkYearAsFiled(year)}
                        className="gap-2"
                    >
                        <Unlock className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("tax.yearActions.unmarkFiled")}
                    </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                <SnapshotHistoryDialog
                    year={year}
                    trigger={
                        <DropdownMenuItem
                            onSelect={(e) => e.preventDefault()}
                            disabled={
                                !snapshotExistsForYear(year) &&
                                !hasFrozen &&
                                !filed
                            }
                            className="gap-2"
                        >
                            <History className="h-3.5 w-3.5 text-muted-foreground" />
                            {t("tax.yearActions.viewHistory")}
                        </DropdownMenuItem>
                    }
                />

                <DropdownMenuItem onSelect={handleExport} className="gap-2">
                    <FileDown className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("tax.yearActions.exportCsv")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
