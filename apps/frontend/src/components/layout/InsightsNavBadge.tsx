import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useInsightsDigest } from "@/hooks/useInsightsDigest";
import {
    countUndismissed,
    loadDismissState,
    subscribeToDismissals,
} from "@/lib/insightsDismiss";

/**
 * Undismissed-insights count next to the Statistics nav item. Shares the
 * digest cache with InsightsDigestPanel (same query key) and re-renders on
 * dismissals via the insightsDismiss listener, so dismissing a row on the
 * Statistics page updates the badge immediately. Renders nothing at zero.
 */
export function InsightsNavBadge() {
    const { data } = useInsightsDigest();
    const [dismissState, setDismissState] = useState(loadDismissState);

    useEffect(() => subscribeToDismissals(setDismissState), []);

    const count = countUndismissed(data, dismissState);
    if (count === 0) return null;

    return (
        <Badge variant="secondary" className="ml-auto shrink-0 px-1.5 py-0 text-[10px] leading-4">
            {count}
        </Badge>
    );
}
