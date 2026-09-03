import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import { watchlistKeys } from "@/lib/queryKeys";

export function useWatchlist(staleTime?: number) {
    return useQuery({
        queryKey: watchlistKeys.all,
        queryFn: () => apiClient.getWatchlist(),
        staleTime,
    });
}

export function useDeleteWatchlistItem() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (id: number) => apiClient.deleteWatchlistItem(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: watchlistKeys.all });
            toast.success(t("watchlist.removedSuccess"));
        },
    });
}
