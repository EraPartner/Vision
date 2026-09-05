import { CloudOff } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";

interface ResearchUnavailableNoteProps {
  /** The provider that was attempted, or null when none was usable. */
  provider?: string | null;
  className?: string;
}

/**
 * Surfaces `meta.source === 'unavailable'` from the research API. Per ADR-079,
 * an unavailable response is genuine — all providers were exhausted, unkeyed, or
 * unhealthy — so the UI shows a "live data unavailable" indicator rather than a
 * loading spinner or a silent blank.
 */
export function ResearchUnavailableNote({ provider, className }: ResearchUnavailableNoteProps) {
  const { t } = useLanguage();
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm",
        className,
      )}
    >
      <CloudOff className="h-4 w-4 mt-0.5 text-warning shrink-0" />
      <div className="flex-1 text-foreground/80">
        <p>{t('research.unavailable')}</p>
        {provider && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('research.unavailableProvider', { provider })}
          </p>
        )}
      </div>
    </div>
  );
}
