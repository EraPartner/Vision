import { useMemo } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { getTaxTable } from "@/lib/belgianTax";
import { buildPortfolioCostBreakdowns } from "@/lib/belgianTax/costBreakdown";
import {
    yearOf,
    enrichInvestmentCosts,
    computeTobRecorded,
    computeTobAutoEstimate,
    computeTacrEstimate,
    computeRealizedGainSplit,
    computeReyndersEstimate,
    computeCgtEstimate,
    computeDividendWht,
    type PortfolioTaxInvestment,
} from "@/lib/belgianTax/portfolioTax";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioTaxAdjustments } from "@/hooks/usePortfolioTaxAdjustments";
import { usePortfolioTaxClassifications } from "@/hooks/usePortfolioTaxClassifications";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { getAssetClassLabel } from "@/types/portfolio";

/** One row of the per-tax-type / per-fee-type breakdown lists. */
export interface CostBreakdownEntry {
    name: string;
    value: number;
}

/** One row of the tax-by-asset-class chart. */
export interface AssetClassTaxDatum {
    name: string;
    taxes: number;
    fees: number;
    total: number;
}

/** One month of the yearly tax/fee trend chart. */
export interface MonthlyCostDatum {
    period: string;
    taxes: number;
    fees: number;
}

/**
 * Domain data for the portfolio-tax page (PortfolioTaxPage).
 *
 * Owns the tax math — per-investment cost enrichment, tax/fee breakdowns,
 * TOB / TACR / Reynders / CGT / dividend-WHT estimates, and the derived
 * totals — so the page itself is pure composition. Formulas and memo
 * dependencies are moved verbatim from the page; rendered numbers are
 * unchanged.
 */
export function usePortfolioTaxData() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const {
        profile: liveProfile,
        viewedYear,
        profileForYear,
        displayCalculationForYear,
    } = useBelgianTaxProfile();
    const profile = profileForYear(viewedYear);
    const calculation = displayCalculationForYear(viewedYear);
    const { summaries: rawSummaries } = usePortfolio();
    const { getAdjustment } = usePortfolioTaxAdjustments();
    const { getClassification } = usePortfolioTaxClassifications();
    // Overlay user-provided tax classifications onto each summary so downstream
    // TOB / Reynders / CGT logic sees per-investment overrides.
    const summaries = useMemo(
        () =>
            rawSummaries.map((inv) => {
                const cls = getClassification(inv.id);
                return { ...inv, ...cls };
            }),
        [rawSummaries, getClassification],
    );
    const targetCurrency = appSettings.defaultCurrency || "EUR";
    const txYear = viewedYear;

    const { convertToTarget } = useCurrencyConverter(targetCurrency);

    const taxTable = getTaxTable(txYear);
    const dividendExemption = taxTable.dividendExemption;

    const enrichedInvestments = useMemo(
        () =>
            summaries.map((inv) => ({
                ...inv,
                assetClassLabel: getAssetClassLabel(t, inv.assetClass),
                ...enrichInvestmentCosts(
                    inv as PortfolioTaxInvestment,
                    txYear,
                    convertToTarget,
                    getAdjustment(txYear, inv.id),
                ),
            })),
        [summaries, txYear, getAdjustment, t, convertToTarget],
    );

    const totalTaxes = enrichedInvestments.reduce((s, i) => s + i.taxes, 0);
    const totalFees = enrichedInvestments.reduce((s, i) => s + i.fees, 0);
    const totalTaxesAndFees = totalTaxes + totalFees;
    const totalRecordedTaxes = enrichedInvestments.reduce(
        (s, i) => s + i.recordedTaxes,
        0,
    );
    const totalRecordedFees = enrichedInvestments.reduce(
        (s, i) => s + i.recordedFees,
        0,
    );
    const totalManualTaxes = enrichedInvestments.reduce(
        (s, i) => s + i.manualTaxes,
        0,
    );
    const totalManualFees = enrichedInvestments.reduce(
        (s, i) => s + i.manualFees,
        0,
    );

    const totalRealizedGain = summaries.reduce(
        (s, i) => s + convertToTarget(i.realizedGain || 0, i.currency),
        0,
    );
    const totalUnrealizedGain = summaries.reduce(
        (s, i) => s + convertToTarget(i.unrealizedGain || 0, i.currency),
        0,
    );
    const effectiveTaxRate =
        totalRealizedGain > 0 ? (totalTaxes / totalRealizedGain) * 100 : 0;
    const portfolioTaxesPlusPIT = calculation.totalPIT + totalTaxes;

    const { taxBreakdown, feeBreakdown } = useMemo(
        () =>
            buildPortfolioCostBreakdowns({
                summaries,
                year: txYear,
                convert: convertToTarget,
                labels: {
                    capitalGainsTax: t("tax.capitalGainsTax"),
                    dividendWithholding: t("tax.dividendWithholding"),
                    transactionTax: t("tax.transactionTax"),
                    otherTaxes: t("tax.otherTaxes"),
                    manualTaxAdjustments: t("tax.manualTaxAdjustments"),
                    brokerFees: t("tax.brokerFees"),
                    managementFees: t("tax.managementFees"),
                    otherFees: t("tax.otherFees"),
                    manualFeeAdjustments: t("tax.manualFeeAdjustments"),
                },
                manualTaxes: totalManualTaxes,
                manualFees: totalManualFees,
            }),
        [
            summaries,
            txYear,
            convertToTarget,
            t,
            totalManualTaxes,
            totalManualFees,
        ],
    );

    const taxByAssetClass = useMemo<AssetClassTaxDatum[]>(() => {
        const map: Record<string, { taxes: number; fees: number }> = {};
        enrichedInvestments.forEach((inv) => {
            const label = inv.assetClassLabel || inv.assetClass;
            if (!map[label]) map[label] = { taxes: 0, fees: 0 };
            map[label].taxes += inv.taxes;
            map[label].fees += inv.fees;
        });
        return Object.entries(map)
            .map(([name, { taxes, fees }]) => ({
                name,
                taxes,
                fees,
                total: taxes + fees,
            }))
            .filter((d) => d.total > 0)
            .sort((a, b) => b.total - a.total);
    }, [enrichedInvestments]);

    const investmentBreakdown = useMemo(
        () =>
            enrichedInvestments
                .map((inv) => ({
                    id: inv.id,
                    name: inv.name,
                    symbol: inv.symbol,
                    assetClass: inv.assetClassLabel,
                    recordedTaxes: inv.recordedTaxes,
                    recordedFees: inv.recordedFees,
                    manualTaxes: inv.manualTaxes,
                    manualFees: inv.manualFees,
                    taxes: inv.taxes,
                    fees: inv.fees,
                    total: inv.total,
                    realizedGain: inv.realizedGain,
                    currency: inv.currency,
                }))
                .filter((i) => i.total > 0)
                .sort((a, b) => b.total - a.total),
        [enrichedInvestments],
    );

    const yearlyCostTrend = useMemo<MonthlyCostDatum[]>(() => {
        const map: Record<
            string,
            { period: string; taxes: number; fees: number }
        > = {};
        summaries.forEach((inv) => {
            inv.transactions.forEach((txn) => {
                if (yearOf(txn.date) !== txYear || !txn.date) return;
                const month = txn.date.slice(0, 7);
                if (!map[month])
                    map[month] = { period: month, taxes: 0, fees: 0 };
                if (txn.type === "tax")
                    map[month].taxes += convertToTarget(
                        Number(txn.amount) || 0,
                        txn.currency,
                    );
                map[month].taxes += convertToTarget(
                    Number(txn.taxes) || 0,
                    txn.currency,
                );
                if (txn.type === "fee")
                    map[month].fees += convertToTarget(
                        Number(txn.amount) || 0,
                        txn.currency,
                    );
                map[month].fees += convertToTarget(
                    Number(txn.fees) || 0,
                    txn.currency,
                );
            });
        });
        return Object.values(map).sort((a, b) =>
            a.period.localeCompare(b.period),
        );
    }, [summaries, txYear, convertToTarget]);

    const {
        totalDividendIncome,
        grossDividendWht,
        dividendWhtReclaim,
        dividendWhtNetCost,
    } = useMemo(
        () =>
            computeDividendWht(
                summaries as PortfolioTaxInvestment[],
                txYear,
                taxTable,
                convertToTarget,
                profile.filingStatus,
            ),
        [summaries, txYear, taxTable, convertToTarget, profile.filingStatus],
    );

    const tobRecorded = useMemo(
        () =>
            computeTobRecorded(
                summaries as PortfolioTaxInvestment[],
                txYear,
                convertToTarget,
            ),
        [summaries, txYear, convertToTarget],
    );

    // Auto-TOB: estimated stock-exchange tax on `buy` transactions, capped per leg. ETFs
    // default to the accumulating-fund rate because retail BE ETFs are predominantly
    // accumulating; users can override per-investment via `etfStructure`. See portfolioTax.ts.
    const tobAutoEstimate = useMemo(
        () =>
            computeTobAutoEstimate(
                summaries as PortfolioTaxInvestment[],
                txYear,
                taxTable,
                convertToTarget,
            ),
        [summaries, txYear, taxTable, convertToTarget],
    );

    // Securities account tax (TACR) — flat rate on accounts averaging ≥ threshold. We don't
    // track per-account averages, so the aggregate current value is a conservative proxy.
    const tacrEstimate = useMemo(
        () =>
            computeTacrEstimate(
                summaries as PortfolioTaxInvestment[],
                taxTable,
                convertToTarget,
            ),
        [summaries, taxTable, convertToTarget],
    );

    // Realized gains routed across the Reynders-interest pool (30%) and the CGT pool (10%,
    // from IY 2026). Full resolution rules (overrides, interest portion, pre/post-2026 bond
    // treatment) live in portfolioTax.ts and are covered by golden tests.
    const cgtActive = taxTable.capitalGainsTaxRate > 0;
    const realizedGainSplit = useMemo(
        () =>
            computeRealizedGainSplit(
                summaries as PortfolioTaxInvestment[],
                convertToTarget,
                cgtActive,
            ),
        [summaries, convertToTarget, cgtActive],
    );

    const reyndersEstimate = useMemo(
        () => computeReyndersEstimate(realizedGainSplit, taxTable),
        [realizedGainSplit, taxTable],
    );

    const cgtEstimate = useMemo(
        () =>
            computeCgtEstimate(
                realizedGainSplit,
                taxTable,
                profile.filingStatus,
                cgtActive,
            ),
        [realizedGainSplit, taxTable, profile.filingStatus, cgtActive],
    );

    const isEmpty = summaries.length === 0;
    const hasProfile =
        liveProfile.profileConfigured || liveProfile.grossAnnualIncome > 0;

    return {
        /** Profile for the viewed year (live or snapshot). */
        profile,
        /** Display PIT calculation for the viewed year (frozen "as-filed" when present). */
        calculation,
        /** Summaries with per-investment tax classifications overlaid. */
        summaries,
        convertToTarget,
        taxTable,
        dividendExemption,
        txYear,
        viewedYear,
        totalTaxes,
        totalFees,
        totalTaxesAndFees,
        totalRecordedTaxes,
        totalRecordedFees,
        totalManualTaxes,
        totalManualFees,
        totalRealizedGain,
        totalUnrealizedGain,
        effectiveTaxRate,
        portfolioTaxesPlusPIT,
        taxBreakdown,
        feeBreakdown,
        taxByAssetClass,
        investmentBreakdown,
        yearlyCostTrend,
        totalDividendIncome,
        grossDividendWht,
        dividendWhtReclaim,
        dividendWhtNetCost,
        tobRecorded,
        tobAutoEstimate,
        tacrEstimate,
        reyndersEstimate,
        cgtEstimate,
        isEmpty,
        hasProfile,
    };
}
