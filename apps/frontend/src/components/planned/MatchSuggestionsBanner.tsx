import { Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
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
export function MatchSuggestionsBanner({ onReview }: MatchSuggestionsBannerProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { suggestions } = usePlannedMatchSuggestions();

    if (suggestions.length === 0) return null;

    return (
        <Card className="glass-regular border-none shadow-md">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-chart-5" />
                    {t('plannedPage.suggestions.title', { n: suggestions.length })}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('plannedPage.suggestions.subtitle')}</p>
                <ul className="divide-y divide-border/50">
                    {suggestions.map((s) => (
                        <li key={s.planned.id} className="flex items-center justify-between gap-3 py-2">
                            <div className="min-w-0">
                                <div className="font-medium truncate">
                                    {s.planned.recipient_name ?? t('plannedPage.suggestions.unnamed')}
                                </div>
                                <div className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
                                    <span>
                                        {s.planned.amount < 0 ? "−" : "+"}
                                        <Money amount={Math.abs(s.planned.amount)} currency={s.planned.currency ?? undefined} />
                                    </span>
                                    <span>·</span>
                                    <span>{formatDateStringWithAppSettings(s.planned.planned_date, appSettings.dateFormat)}</span>
                                    <span>·</span>
                                    <span>{t('plannedPage.suggestions.candidateCount', { n: s.candidates.length })}</span>
                                </div>
                            </div>
                            <Button size="sm" variant="secondary" onClick={() => onReview(s.planned.id)}>
                                {t('plannedPage.suggestions.review')}
                            </Button>
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
}
