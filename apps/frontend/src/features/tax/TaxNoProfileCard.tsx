import { Calculator, Landmark } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";
import { EmptyState } from "@/components/shared/EmptyState";

/** Empty state of the overview page when no tax profile or stats data exists yet. */
export function TaxNoProfileCard() {
    const { t } = useLanguage();
    return (
        <Card>
            <CardContent variant="flush">
                <EmptyState
                    icon={Landmark}
                    title={t("tax.noProfile.title")}
                    description={t("tax.noProfile.desc")}
                    action={
                        <TaxProfileDialog
                            trigger={
                                <Button size="sm" className="gap-2">
                                    <Calculator className="h-4 w-4" />
                                    {t("tax.profile.setup")}
                                </Button>
                            }
                        />
                    }
                />
            </CardContent>
        </Card>
    );
}
