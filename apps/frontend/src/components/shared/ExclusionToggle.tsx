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
  // Nothing to toggle when Settings has no exclusions: the control is hidden rather
  // than shown disabled.
  if (!exclusionsApply) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isFiltered ? "default" : "outline"}
            size="sm"
            className={cn(
              "h-8 gap-2 text-xs ml-4 font-medium transition-colors",
              isFiltered
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'hover:bg-muted'
            )}
            onClick={() => onToggle(graphKey)}
          >
            {isFiltered ? <Filter className="h-4 w-4" /> : <FilterX className="h-4 w-4" />}
            {isFiltered ? t('exclusion.filtersActive') : t('exclusion.filtersIgnored')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isFiltered ? t('exclusion.tooltipActive') : t('exclusion.tooltipInactive')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
