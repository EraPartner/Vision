import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { useAdapters } from "./useAdapters";

export function SupportedBanksCard() {
    const { t } = useLanguage();
    const { adapters, loading } = useAdapters();

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle variant="sm">
                    {t("importPage.supportedBanks")}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                    {loading ? (
                        <Badge
                            variant="secondary"
                            role="status"
                            className="gap-1.5"
                        >
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("importPage.supportedLoading")}
                        </Badge>
                    ) : adapters.length > 0 ? (
                        adapters.map((adapter) => (
                            <Badge key={adapter.key}>{adapter.name}</Badge>
                        ))
                    ) : (
                        <span className="type-footnote text-label-secondary">
                            {t("importPage.noSupportedParsers")}
                        </span>
                    )}
                </div>
                <p className="type-footnote text-label-secondary">
                    {t("importPage.noSupportedBank")}
                </p>
            </CardContent>
        </Card>
    );
}
