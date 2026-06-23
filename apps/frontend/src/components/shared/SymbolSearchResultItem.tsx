import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Shape shared by the research (`searchResearch`) and market (`searchMarket`) search results. */
export interface SymbolSearchResult {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

interface SymbolSearchResultItemProps {
  item: SymbolSearchResult;
  onSelect: (item: SymbolSearchResult) => void;
  /** Optional leading affordance (e.g. a Plus icon) for add-to-list pickers. */
  leadingIcon?: ReactNode;
  className?: string;
}

/**
 * Canonical company/ticker search-result row, shared across every symbol picker
 * (Research home, Market Lookup, Compare, Chart Builder, Add-to-Watchlist) so
 * they stay visually consistent: mono ticker, company name, asset-type badge,
 * and exchange. Add-style pickers pass a `leadingIcon` (a Plus); navigate-style
 * pickers omit it.
 */
export function SymbolSearchResultItem({ item, onSelect, leadingIcon, className }: SymbolSearchResultItemProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/70",
        className,
      )}
    >
      {leadingIcon}
      <span className="min-w-[5rem] font-mono text-sm font-bold text-foreground">{item.symbol}</span>
      <span className="flex-1 truncate text-sm text-muted-foreground">{item.name}</span>
      {item.type ? <Badge variant="outline" className="shrink-0 text-[10px]">{item.type}</Badge> : null}
      {item.exchange ? <span className="shrink-0 text-xs text-muted-foreground">{item.exchange}</span> : null}
    </button>
  );
}
