import { Disclosure, DisclosureSummary, DisclosureContent } from "@/components/ui/disclosure";
import { useLanguage } from "@/stores/hydration/LanguageHydration";


/** Static Belgian tax-rules reference of the overview page ("taxRules" widget). */
export function TaxRulesCard() {
    const { t } = useLanguage();

    const taxRuleCards = [
        {
            title: t("tax.rules.federalBracketsTitle"),
            items: [
                t("tax.rules.federalBrackets.1"),
                t("tax.rules.federalBrackets.2"),
                t("tax.rules.federalBrackets.3"),
                t("tax.rules.federalBrackets.4"),
            ],
        },
        {
            title: t("tax.rules.socialSecurityTitle"),
            items: [
                t("tax.rules.ss.employee"),
                t("tax.rules.ss.special"),
                t("tax.rules.ss.employer"),
                t("tax.rules.ss.selfEmployed"),
            ],
        },
        {
            title: t("tax.rules.investmentTitle"),
            items: [
                t("tax.rules.investment.savings"),
                t("tax.rules.investment.dividends"),
                t("tax.rules.investment.foreign"),
            ],
        },
        {
            title: t("tax.rules.otherTaxesTitle"),
            items: [
                t("tax.rules.other.vat"),
                t("tax.rules.other.tob"),
                t("tax.rules.other.property"),
            ],
        },
    ];

    return (
        <Disclosure variant="card">
            <DisclosureSummary padded>{t("tax.rules.title")}</DisclosureSummary>
            <DisclosureContent className="space-y-3">
                <p className="type-footnote text-label-secondary">{t("tax.rules.description")}</p>
                {taxRuleCards.map((rule) => (
                    <section
                        key={rule.title}
                        className="rounded-card corner-continuous bg-foreground/[0.04] p-4"
                    >
                        <h3 className="type-headline text-foreground">
                            {rule.title}
                        </h3>
                        <ul className="mt-2 list-disc space-y-1 pl-4">
                            {rule.items.map((item) => (
                                <li
                                    key={item}
                                    className="type-footnote leading-relaxed text-label-secondary"
                                >
                                    {item}
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </DisclosureContent>
        </Disclosure>
    );
}
