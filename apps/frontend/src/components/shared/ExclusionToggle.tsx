import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Filter, FilterX } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface ExclusionToggleProps {
    graphKey: string;
    isFiltered: boolean;
    onToggle: (key: string) => void;
    exclusionsApply: boolean;
}

export function ExclusionToggle({
    graphKey,
    isFiltered,
    onToggle,
    exclusionsApply,
}: ExclusionToggleProps) {
    const { t } = useLanguage();
    // Nothing to toggle when Settings has no exclusions: the control is hidden rather
    // than shown disabled.
    if (!exclusionsApply) return null;
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        aria-pressed={isFiltered}
                        className={
                            isFiltered
                                ? "border-primary/25 bg-primary/5 text-primary"
                                : undefined
                        }
                        onClick={() => onToggle(graphKey)}
                    >
                        {isFiltered ? (
                            <Filter aria-hidden="true" />
                        ) : (
                            <FilterX aria-hidden="true" />
                        )}
                        {isFiltered
                            ? t("exclusion.filtersActive")
                            : t("exclusion.filtersIgnored")}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>
                    {isFiltered
                        ? t("exclusion.tooltipActive")
                        : t("exclusion.tooltipInactive")}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
