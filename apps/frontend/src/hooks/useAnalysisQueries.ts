import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import type { AnalysisWorkspace } from "@/lib/api/analysis";

export function useAnalysisWorkspaceQueries(workspace: AnalysisWorkspace) {
    const catalog = useQuery({
        queryKey: ["analysis", "catalog"],
        queryFn: apiClient.getAnalysisCatalog,
    });
    const saved = useQuery({
        queryKey: ["analysis", "saved", workspace],
        queryFn: () => apiClient.listSavedAnalyses(workspace),
    });
    return { catalog, saved };
}
