import { useMemo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { resolveBelgianTaxHouseholdResult } from "@/stores/belgianTaxStore";
import type {
    HouseholdTaxResult,
    PartnerTaxResult,
} from "@/lib/belgianTax/householdTypes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
    Disclosure,
    DisclosureContent,
    DisclosureSummary,
} from "@/components/ui/disclosure";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { KeyValueRows, type KeyValueRow } from "./KeyValueRows";
import { partnerLabel } from "./profile-steps/householdEditing";

interface HouseholdBreakdownCardProps {
    viewedYear: number;
}

type RowTone = "base" | "reduction" | "adjustment" | "total";

interface BreakdownRow {
    key: string;
    label: string;
    value: (partner: PartnerTaxResult) => number;
    tone: RowTone;
}

const sum = (result: HouseholdTaxResult, pick: (p: PartnerTaxResult) => number) =>
    result.partners.reduce((total, p) => total + pick(p), 0);

/**
 * Per-partner breakdown of a two-partner household (ADR-200): taxable income, tax-free sum
 * charged (`exemption.applied`), tax after the tax-free sum, reductions, the regional factor
 * and communal surcharge, and final tax for each partner and the household, so that each
 * column adds up,
 * with the assessment mode and the marital quotient. Renders nothing for one partner.
 */
export function HouseholdBreakdownCard({ viewedYear }: HouseholdBreakdownCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();
    const inputs = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        snapshots: state.snapshots,
        household: state.household,
        householdSnapshots: state.householdSnapshots,
        householdResult: state.householdResult,
        snapshotMetas: state.snapshotMetas,
    }));
    const result = useMemo(
        () => resolveBelgianTaxHouseholdResult(inputs, viewedYear),
        [inputs, viewedYear],
    );

    if (!result || result.partners.length < 2) return null;

    const rows: BreakdownRow[] = [
        {
            key: "taxableIncome",
            label: t("tax.pit.row.taxableIncome"),
            value: (p) => p.taxableIncome,
            tone: "base",
        },
        {
            key: "taxFreeSum",
            label: t("tax.householdBreakdown.row.taxFreeSum"),
            value: (p) => p.exemption.applied,
            tone: "base",
        },
        {
            key: "pitAfterExemption",
            label: t("tax.householdBreakdown.row.pitAfterExemption"),
            value: (p) => p.pitAfterExemption,
            tone: "base",
        },
        {
            key: "reductions",
            label: t("tax.householdBreakdown.row.reductions"),
            value: (p) => p.reductionsApplied,
            tone: "reduction",
        },
        {
            key: "regionalAndCommunal",
            label: t("tax.householdBreakdown.row.regionalAndCommunal"),
            value: (p) => p.totalPIT - (p.pitAfterExemption - p.reductionsApplied),
            tone: "adjustment",
        },
        {
            key: "finalTax",
            label: t("tax.householdBreakdown.row.finalTax"),
            value: (p) => p.totalPIT,
            tone: "total",
        },
    ];

    const { assessment, quotient } = result;
    const summaryRows: KeyValueRow[] = [
        {
            key: "assessment",
            label: t("tax.householdBreakdown.assessment"),
            value: t(`tax.household.assessment.mode.${assessment.mode}`),
        },
    ];
    if (assessment.mode === "joint") {
        summaryRows.push({
            key: "quotient",
            label: t("tax.householdBreakdown.quotient"),
            value:
                quotient.applied && quotient.fromPartnerId && quotient.toPartnerId
                    ? t("tax.householdBreakdown.quotient.transfer", {
                          amount: fmt(quotient.transfer),
                          from: partnerLabel(t, quotient.fromPartnerId),
                          to: partnerLabel(t, quotient.toPartnerId),
                      })
                    : t("tax.householdBreakdown.quotient.notApplied"),
        });
        if (quotient.applied) {
            summaryRows.push({
                key: "quotientBenefit",
                label: t("tax.householdBreakdown.quotient.benefit"),
                value: fmt(quotient.benefit),
                tone: "text-gain",
            });
        }
    }

    return (
        <Disclosure variant="card">
            <DisclosureSummary padded>
                {t("tax.householdBreakdown.title")}
            </DisclosureSummary>
            <DisclosureContent className="space-y-3">
                <p className="type-footnote text-label-secondary">
                    {t("tax.householdBreakdown.description", {
                        year: String(viewedYear),
                    })}
                </p>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t("tax.pit.table.component")}</TableHead>
                            {result.partners.map((p) => (
                                <TableHead key={p.partnerId} className="text-right">
                                    {partnerLabel(t, p.partnerId)}
                                </TableHead>
                            ))}
                            <TableHead className="text-right">
                                {t("tax.householdBreakdown.column.household")}
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => {
                            const cellClass = cn(
                                "text-right tabular-nums",
                                row.tone === "reduction" && "text-gain",
                                row.tone === "total" && "font-medium text-foreground",
                            );
                            const format = (value: number) =>
                                row.tone === "reduction"
                                    ? fmt(-value, { signed: true })
                                    : row.tone === "adjustment"
                                      ? fmt(value, { signed: true })
                                      : fmt(value);
                            return (
                                <TableRow key={row.key}>
                                    <TableCell
                                        className={cn(
                                            row.tone === "total" &&
                                                "font-medium text-foreground",
                                        )}
                                    >
                                        {row.label}
                                    </TableCell>
                                    {result.partners.map((p) => (
                                        <TableCell key={p.partnerId} className={cellClass}>
                                            {format(row.value(p))}
                                        </TableCell>
                                    ))}
                                    <TableCell
                                        className={cn(
                                            cellClass,
                                            row.tone === "total" && "text-primary",
                                        )}
                                    >
                                        {format(sum(result, row.value))}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
                <KeyValueRows rows={summaryRows} />
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" size="sm">
                        {assessment.legalBasis}
                    </Badge>
                    <span className="type-footnote text-label-secondary">
                        {t(`tax.household.assessment.reason.${assessment.reason}`)}
                    </span>
                </div>
            </DisclosureContent>
        </Disclosure>
    );
}
