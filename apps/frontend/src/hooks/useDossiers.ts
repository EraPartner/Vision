import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import type { DossierContent } from "@/lib/api/dossiers";

const key = ["research-dossiers"] as const;

export function useDossiers(offset = 0) {
    return useQuery({
        queryKey: [...key, "list", offset],
        queryFn: () => apiClient.listDossiers(offset),
    });
}

export function useDossierPickers() {
    const categories = useQuery({
        queryKey: ["categories", "tree"],
        queryFn: apiClient.getCategoryTree,
    });
    const investments = useQuery({
        queryKey: ["investments", "dossier-picker"],
        queryFn: () => apiClient.getInvestments({ limit: 1000 }),
    });
    const analyses = useQuery({
        queryKey: ["analysis", "saved", "dossier-picker"],
        queryFn: () => apiClient.listSavedAnalyses(),
    });
    const documents = useQuery({
        queryKey: ["ai-research", "documents", "dossier-picker"],
        queryFn: apiClient.listResearchDocuments,
    });
    return { categories, investments, analyses, documents };
}

export function useDossier(id: string | null) {
    return useQuery({
        queryKey: [...key, id],
        queryFn: () => apiClient.getDossier(id!),
        enabled: Boolean(id),
    });
}

export function useDossierVersions(id: string | null) {
    return useQuery({
        queryKey: [...key, id, "versions"],
        queryFn: () => apiClient.listDossierVersions(id!),
        enabled: Boolean(id),
    });
}

export function useDossierActions() {
    const cache = useQueryClient();
    const refresh = async () => cache.invalidateQueries({ queryKey: key });
    return {
        create: useMutation({
            mutationFn: apiClient.createDossier,
            onSuccess: refresh,
        }),
        update: useMutation({
            mutationFn: ({
                id,
                content,
                expectedVersion,
            }: {
                id: string;
                content: DossierContent;
                expectedVersion: number;
            }) => apiClient.updateDossier(id, content, expectedVersion),
            onSuccess: refresh,
        }),
        remove: useMutation({
            mutationFn: apiClient.deleteDossier,
            onSuccess: refresh,
        }),
        restore: useMutation({
            mutationFn: ({
                id,
                version,
                expectedVersion,
            }: {
                id: string;
                version: number;
                expectedVersion: number;
            }) => apiClient.restoreDossierVersion(id, version, expectedVersion),
            onSuccess: refresh,
        }),
    };
}
