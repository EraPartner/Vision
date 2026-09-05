import { Button } from "@/components/ui/button";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { Filter, FilterX } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";

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
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isFiltered && exclusionsApply ? "default" : "outline"}
            size="sm"
            className={cn(
              "h-8 gap-2 text-xs ml-4 font-medium transition-colors",
              isFiltered && exclusionsApply
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'hover:bg-muted'
            )}
            onClick={() => onToggle(graphKey)}
            disabled={!exclusionsApply}
          >
            {isFiltered ? <Filter className="h-4 w-4" /> : <FilterX className="h-4 w-4" />}
            {exclusionsApply
              ? (isFiltered ? t('exclusion.filtersActive') : t('exclusion.filtersIgnored'))
              : t('exclusion.noExclusions')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {!exclusionsApply
            ? t('exclusion.tooltipNone')
            : isFiltered
              ? t('exclusion.tooltipActive')
              : t('exclusion.tooltipInactive')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
