/**
 * YearActionsMenu
 *
 * The tax pages' header ••• menu. It holds the page's secondary actions (passed
 * in as `pageItems`: Export PDF…, Customize…) and the per-year actions from
 * ADR-059: freeze/unfreeze the calculation, mark as filed / unfile, view the
 * audit history, and export the year as CSV.
 *
 * Wired against the currently-viewed year.
 */
import type { ReactNode } from "react";
import { Snowflake, Lock, History, FileDown, Unlock } from "lucide-react";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RowMenu } from "@/components/shared/RowMenu";
import { MarkAsFiledDialog } from "./MarkAsFiledDialog";
import { SnapshotHistoryDialog } from "./SnapshotHistoryDialog";
import { exportTaxYearCsv } from "@/lib/belgianTax/exportTaxYearCsv";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";

interface YearActionsMenuProps {
    /** The year the menu operates on. Typically the page's `viewedYear`. */
    year: number;
    /** Page-level items (export, customize…) shown above the year actions. */
    pageItems?: ReactNode;
}

const itemIconClass = "mr-2 h-4 w-4 text-label-secondary";

export function YearActionsMenu({ year, pageItems }: YearActionsMenuProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const {
        liveYear,
        snapshotExists,
        profileForYear,
        displayCalculationForYear,
        hasFrozen,
        filed,
        freezeCalculation,
        unfreezeCalculation,
        unmarkYearAsFiled,
    } = useBelgianTaxProfile((state) => ({
        liveYear: state.profile.taxYear,
        snapshotExists: Object.prototype.hasOwnProperty.call(
            state.snapshots,
            year,
        ),
        profileForYear: state.profileForYear,
        displayCalculationForYear: state.displayCalculationForYear,
        hasFrozen: Boolean(state.snapshotMetas[year]?.frozenCalculation),
        filed: Boolean(state.snapshotMetas[year]?.filing),
        freezeCalculation: state.freezeCalculation,
        unfreezeCalculation: state.unfreezeCalculation,
        unmarkYearAsFiled: state.unmarkYearAsFiled,
    }));

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
        <RowMenu
            variant="outline"
            size="icon"
            label={t("tax.menu.label")}
            contentClassName="min-w-[240px]"
        >
            {pageItems && (
                <>
                    {pageItems}
                    <DropdownMenuSeparator />
                </>
            )}
            <DropdownMenuLabel>
                {t("tax.yearActions.menuLabel", { year: String(year) })}
            </DropdownMenuLabel>

            {!filed && !hasFrozen && (
                <DropdownMenuItem onSelect={() => freezeCalculation(year)}>
                    <Snowflake className={itemIconClass} />
                    {t("tax.yearActions.freeze")}
                </DropdownMenuItem>
            )}
            {!filed && hasFrozen && (
                <DropdownMenuItem onSelect={() => unfreezeCalculation(year)}>
                    <Snowflake className={itemIconClass} />
                    {t("tax.yearActions.unfreeze")}
                </DropdownMenuItem>
            )}

            {!filed && year !== liveYear && (
                <MarkAsFiledDialog
                    year={year}
                    trigger={
                        <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                            <Lock className={itemIconClass} />
                            {t("tax.yearActions.markFiled")}
                        </DropdownMenuItem>
                    }
                />
            )}
            {filed && (
                <DropdownMenuItem onSelect={() => unmarkYearAsFiled(year)}>
                    <Unlock className={itemIconClass} />
                    {t("tax.yearActions.unmarkFiled")}
                </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />

            <SnapshotHistoryDialog
                year={year}
                trigger={
                    <DropdownMenuItem
                        onSelect={(e) => e.preventDefault()}
                        disabled={!snapshotExists && !hasFrozen && !filed}
                    >
                        <History className={itemIconClass} />
                        {t("tax.yearActions.viewHistory")}
                    </DropdownMenuItem>
                }
            />

            <DropdownMenuItem onSelect={handleExport}>
                <FileDown className={itemIconClass} />
                {t("tax.yearActions.exportCsv")}
            </DropdownMenuItem>
        </RowMenu>
    );
}
