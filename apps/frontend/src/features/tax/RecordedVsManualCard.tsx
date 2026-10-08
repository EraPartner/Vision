import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { KeyValueRows } from "./KeyValueRows";

interface RecordedVsManualCardProps {
    totalRecordedTaxes: number;
    totalRecordedFees: number;
    totalManualTaxes: number;
    totalManualFees: number;
    totalTaxesAndFees: number;
}

/** Recorded-vs-manual cost split card of the portfolio-tax page. */
export function RecordedVsManualCard({
    totalRecordedTaxes,
    totalRecordedFees,
    totalManualTaxes,
    totalManualFees,
    totalTaxesAndFees,
}: RecordedVsManualCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.recordedVsManual")}</CardTitle>
                <CardDescription>
                    {t("tax.recordedVsManualDesc")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <KeyValueRows
                    rows={[
                        {
                            key: "recordedTaxes",
                            label: t("tax.recordedTaxes"),
                            value: fmt(totalRecordedTaxes),
                            tone: "text-loss",
                        },
                        {
                            key: "recordedFees",
                            label: t("tax.recordedFees"),
                            value: fmt(totalRecordedFees),
                            tone: "text-loss",
                        },
                        {
                            key: "manualTaxes",
                            label: t("tax.manualTaxAdjustments"),
                            value: fmt(totalManualTaxes),
                            tone: "text-label-secondary",
                        },
                        {
                            key: "manualFees",
                            label: t("tax.manualFeeAdjustments"),
                            value: fmt(totalManualFees),
                            tone: "text-label-secondary",
                        },
                        {
                            key: "total",
                            label: t("tax.totalCosts"),
                            value: fmt(totalTaxesAndFees),
                            tone: "text-primary",
                            emphasis: true,
                        },
                    ]}
                />
            </CardContent>
        </Card>
    );
}
