import { Button } from "@/components/ui/button";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { Filter, FilterX } from "lucide-react";

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
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isFiltered && exclusionsApply ? "default" : "outline"}
            size="sm"
            className={`h-8 gap-2 text-xs ml-4 font-medium transition-colors ${
              isFiltered && exclusionsApply 
                ? 'bg-primary text-primary-foreground hover:bg-primary/90' 
                : 'hover:bg-muted'
            }`}
            onClick={() => onToggle(graphKey)}
            disabled={!exclusionsApply}
          >
            {isFiltered ? <Filter className="h-4 w-4" /> : <FilterX className="h-4 w-4" />}
            {exclusionsApply
              ? (isFiltered ? "Filters Active" : "Filters Ignored")
              : "No exclusions set"}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {!exclusionsApply
            ? "No exclusions configured in settings"
            : isFiltered
              ? "Exclusions applied — click to show all data"
              : "Showing all data — click to apply exclusions"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
