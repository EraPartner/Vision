import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { cn } from "@/lib/utils";

/**
 * Branded, content-neutral loading placeholder — a shimmer skeleton stack used
 * in place of a bare centered spinner for page/section content loads. (Inline
 * button-busy states keep their Loader2 spinner.)
 */
export function SectionLoader({ className }: { className?: string }) {
    return (
        <div {...loadingSurfaceProps} className={cn("space-y-3", className)}>
            <Skeleton className="h-7 w-1/3" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
        </div>
    );
}
