import { Landmark, SlidersHorizontal } from "lucide-react";
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
            <CardContent variant="state">
                <EmptyState
                    icon={Landmark}
                    title={t("tax.noProfile.title")}
                    description={t("tax.noProfile.desc")}
                    action={
                        <TaxProfileDialog
                            trigger={
                                <Button>
                                    <SlidersHorizontal />
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
