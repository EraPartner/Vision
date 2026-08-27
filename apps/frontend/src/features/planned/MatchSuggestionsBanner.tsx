import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePlannedMatchSuggestions } from "@/hooks/usePlannedMatchSuggestions";

interface MatchSuggestionsBannerProps {
    /** Opens the link dialog for the chosen planned payment so the user can confirm. */
    onReview: (plannedId: number) => void;
}

/**
 * Surfaces planned payments with likely matching transactions that were not
 * auto-cleared. Hidden entirely when there are no suggestions. Confirming runs
 * through the existing LinkTransactionDialog → execute path (no clear logic here).
 */
export function MatchSuggestionsBanner({
    onReview,
}: MatchSuggestionsBannerProps) {
    const { t } = useLanguage();
    const { suggestions } = usePlannedMatchSuggestions();

    if (suggestions.length === 0) return null;

    return (
        <Card className="border-none shadow-md">
            <CardContent className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Sparkles className="h-4 w-4 shrink-0 text-chart-5" />
                        <span>
                            {t("plannedPage.suggestions.title", {
                                n: suggestions.length,
                            })}
                        </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t("plannedPage.suggestions.subtitle")}
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => onReview(suggestions[0].planned.id)}
                >
                    {t("plannedPage.suggestions.review")}
                </Button>
            </CardContent>
        </Card>
    );
}
