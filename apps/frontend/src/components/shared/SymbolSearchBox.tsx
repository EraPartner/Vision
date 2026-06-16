import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SymbolSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Whether the results dropdown should be shown. */
  open: boolean;
  /** Result rows plus any empty / unavailable / no-results states. */
  children: ReactNode;
  autoFocus?: boolean;
  /** Shows a spinner on the trailing edge of the input while fetching. */
  loading?: boolean;
  /** Defaults to `placeholder` when omitted. */
  ariaLabel?: string;
  /** Layout/width class for the outer wrapper (e.g. `max-w-2xl`). */
  className?: string;
}

/**
 * Canonical ticker/company search box, shared across every symbol picker
 * (Research home, Market Lookup, Compare, Chart Builder) so they stay visually
 * consistent: a tall glass input with a leading search icon and a glass-elevated
 * results dropdown. Pages supply their own results/states as `children` and own
 * the query logic; this component only owns the chrome. Rows inside should use
 * {@link SymbolSearchResultItem}.
 */
export function SymbolSearchBox({
  value,
  onChange,
  placeholder,
  open,
  children,
  autoFocus,
  loading,
  ariaLabel,
  className,
}: SymbolSearchBoxProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
      <Input
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-14 pl-12 text-base glass-regular"
        aria-label={ariaLabel ?? placeholder}
      />
      {loading ? (
        <div className="absolute right-4 top-1/2 -translate-y-1/2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : null}
      {open ? (
        <Card className="absolute z-50 top-full mt-2 w-full glass-thick">
          <CardContent className="p-1">{children}</CardContent>
        </Card>
      ) : null}
    </div>
  );
}
