import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** "What is automatic vs manual" explainer card of the overview page. */
export function TaxAutomationCard() {
    const { t } = useLanguage();
    const rows = [
        {
            key: "automatic",
            label: t("tax.automation.automatic"),
            text: t("tax.automation.automaticDesc"),
        },
        {
            key: "manual",
            label: t("tax.automation.manualLabel"),
            text: t("tax.automation.manualDesc"),
        },
        {
            key: "investment",
            label: t("tax.automation.investmentLabel"),
            text: t("tax.automation.investmentDesc"),
        },
    ];
    return (
        <Card>
            <CardHeader>
                <CardTitle variant="sm">{t("tax.automation.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {rows.map((row) => (
                    <p
                        key={row.key}
                        className="type-callout text-label-secondary"
                    >
                        <span className="type-headline text-foreground">
                            {row.label}:
                        </span>{" "}
                        {row.text}
                    </p>
                ))}
            </CardContent>
        </Card>
    );
}
