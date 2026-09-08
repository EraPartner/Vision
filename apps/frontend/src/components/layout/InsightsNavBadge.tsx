import { Badge } from "@/components/ui/badge";
import { useInsightsCount } from "@/hooks/useInsightsDigest";

/**
 * Undismissed-insights count next to the Statistics nav item. The request only
 * reads the persisted count projection; it never runs the full detectors.
 */
export function InsightsNavBadge() {
    const { data } = useInsightsCount();
    if (data?.status !== "ready" || !data.count) return null;

    return (
        <Badge
            variant="secondary"
            className="ml-auto shrink-0 px-1.5 py-0 text-2xs leading-4"
        >
            {data.count}
        </Badge>
    );
}
