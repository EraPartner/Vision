/**
 * Transaction-derived Belgian deduction candidates for the Tax Overview
 * review card.
 *
 * Shared react-query wrapper around GET /api/info/deduction-candidates so
 * every consumer of a given year hits one cache entry. Failures remain query
 * errors so the review card can distinguish an outage from no candidates.
 */

import { useQuery } from "@tanstack/react-query";
import {
    getDeductionCandidates,
    type DeductionCandidatesResponse,
} from "@/lib/api/info";
import { taxKeys } from "@/lib/queryKeys";

export function useDeductionCandidates(year: number) {
    return useQuery<DeductionCandidatesResponse>({
        queryKey: taxKeys.deductionCandidates(year),
        queryFn: () => getDeductionCandidates(year),
        // 5 min: ledger-derived, only changes on imports/edits — no need to
        // refetch on every navigation back to the tax page.
        staleTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}
