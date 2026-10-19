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
import { toast } from "sonner";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { RowMenu } from "@/components/shared/RowMenu";
import { MarkAsFiledDialog } from "./MarkAsFiledDialog";
import { SnapshotHistoryDialog } from "./SnapshotHistoryDialog";
import { exportTaxYearCsv } from "@/lib/belgianTax/exportTaxYearCsv";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    resolveBelgianTaxHousehold,
    resolveTaxYearFigures,
} from "@/stores/belgianTaxStore";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import logger from "@/lib/logger";

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
        snapshotExists,
        profileForYear,
        hasFrozen,
        filed,
        freezeCalculation,
        unfreezeCalculation,
        unmarkYearAsFiled,
        ...yearState
    } = useBelgianTaxProfile((state) => ({
        snapshotExists: Object.prototype.hasOwnProperty.call(
            state.snapshots,
            year,
        ),
        profileForYear: state.profileForYear,
        hasFrozen: Boolean(state.snapshotMetas[year]?.frozenCalculation),
        filed: Boolean(state.snapshotMetas[year]?.filing),
        freezeCalculation: state.freezeCalculation,
        unfreezeCalculation: state.unfreezeCalculation,
        unmarkYearAsFiled: state.unmarkYearAsFiled,
        household: state.household,
        householdSnapshots: state.householdSnapshots,
        snapshotMetas: state.snapshotMetas,
    }));

    function reportComputeFailure(error: unknown) {
        logger.error("Failed to compute the Belgian tax year:", error);
        toast.error(t("tax.yearActions.computeFailed", { year: String(year) }), {
            description: apiErrorToMessage(error, t),
        });
    }

    function handleFreeze() {
        freezeCalculation(year).catch(reportComputeFailure);
    }

    // The server's figures for the year (the frozen ones for a frozen year, never a recompute).
    async function handleExport() {
        try {
            const figures = await resolveTaxYearFigures(yearState, year);
            if (!figures) return;
            exportTaxYearCsv({
                year,
                profile: profileForYear(year),
                calculation: figures.calculation,
                currency: appSettings.defaultCurrency || "EUR",
                isFiled: filed,
                hasFrozenCalculation: hasFrozen,
                // Friendly stamp for the file header.
                generatedAt: new Date().toISOString(),
                household: resolveBelgianTaxHousehold(yearState, year),
                // A year frozen before the household result was stored has none to export.
                householdResult: figures.householdResult,
            });
        } catch (error) {
            reportComputeFailure(error);
        }
    }

    return (
        <>
            {!filed && (
                <MarkAsFiledDialog
                    year={year}
                    trigger={
                        <Button variant="outline">
                            <Lock />
                            {t("tax.yearActions.markFiled")}
                        </Button>
                    }
                />
            )}
            <Button variant="outline" onClick={() => void handleExport()}>
                <FileDown />
                {t("tax.yearActions.exportCsv")}
            </Button>
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
                    <DropdownMenuItem onSelect={handleFreeze}>
                        <Snowflake className={itemIconClass} />
                        {t("tax.yearActions.freeze")}
                    </DropdownMenuItem>
                )}
                {!filed && hasFrozen && (
                    <DropdownMenuItem
                        onSelect={() => unfreezeCalculation(year)}
                    >
                        <Snowflake className={itemIconClass} />
                        {t("tax.yearActions.unfreeze")}
                    </DropdownMenuItem>
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

                <DropdownMenuItem onSelect={() => void handleExport()}>
                    <FileDown className={itemIconClass} />
                    {t("tax.yearActions.exportCsv")}
                </DropdownMenuItem>
            </RowMenu>
        </>
    );
}
