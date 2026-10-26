import { HardDrive, Search, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface InvestigationPrivacySummaryProps {
    researchMode: "local-only" | "public-providers" | "public-web";
    depth: "quick" | "detailed";
}

export function InvestigationPrivacySummary({
    researchMode,
    depth,
}: InvestigationPrivacySummaryProps) {
    const { t } = useLanguage();
    const researchProfiles = {
        "local-only": [
            "aiResearch.localOnly",
            "aiResearch.summary.researchLocal",
            "aiResearch.researchLocalProfile",
        ],
        "public-providers": [
            "aiResearch.publicProviders",
            "aiResearch.summary.researchProviders",
            "aiResearch.researchProvidersProfile",
        ],
        "public-web": [
            "aiResearch.publicWeb",
            "aiResearch.summary.researchWeb",
            "aiResearch.researchWebProfile",
        ],
    } as const;
    const researchCopy = researchProfiles[researchMode];
    return (
        <Card asChild>
            <section aria-label={t("aiResearch.summary.title")}>
                <CardContent variant="compact">
                    <div className="grid gap-4 sm:grid-cols-3">
                        {([
                            {
                                Icon: ShieldCheck,
                                title: "aiResearch.summary.localTitle",
                                body: "aiResearch.summary.localBody",
                            },
                            {
                                Icon: Search,
                                title: researchCopy[0],
                                body: researchCopy[1],
                            },
                            {
                                Icon: HardDrive,
                                title: "aiResearch.summary.savedTitle",
                                body: "aiResearch.summary.savedLocal",
                            },
                        ] as const).map(({ Icon, title, body }) => (
                            <div
                                key={title}
                                className="flex items-start gap-2.5"
                            >
                                <Icon
                                    aria-hidden="true"
                                    className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                                />
                                <div>
                                    <p className="type-headline">{t(title)}</p>
                                    <p className="mt-1 type-footnote text-label-secondary">
                                        {t(body)}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                    <Disclosure className="mt-3 border-t border-border/50 pt-3 type-footnote">
                        <DisclosureSummary
                            tone="footnote"
                            className="rounded-chip"
                        >
                            {t("aiResearch.modeGuideTitle")}
                        </DisclosureSummary>
                        <dl className="mt-3 space-y-3 text-label-secondary">
                            <div>
                                <dt className="type-footnote font-medium text-foreground">
                                    {t("aiResearch.route")}
                                </dt>
                                <dd>{t("aiResearch.modeLocalProfile")}</dd>
                            </div>
                            <div>
                                <dt className="type-footnote font-medium text-foreground">
                                    {t("aiResearch.researchProfilesTitle")}
                                </dt>
                                <dd>{t(researchCopy[2])}</dd>
                            </div>
                            <div>
                                <dt className="type-footnote font-medium text-foreground">
                                    {t("aiResearch.depthProfilesTitle")}
                                </dt>
                                <dd>
                                    {t(
                                        depth === "quick"
                                            ? "aiResearch.quickProfile"
                                            : "aiResearch.detailedProfile",
                                    )}
                                </dd>
                            </div>
                        </dl>
                    </Disclosure>
                </CardContent>
            </section>
        </Card>
    );
}
