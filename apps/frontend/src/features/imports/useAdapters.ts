import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { importKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";

export interface BankAdapter {
    key: string;
    name: string;
    adapter_class?: string;
}

export function useAdapters(enabled = true) {
    const { t } = useLanguage();

    // The supported-parser list is near-static; a shared React Query entry dedupes
    // the import-page cards and the onboarding wizard that each used to fetch it,
    // and stops the refetch that fired on every language switch (the old useEffect
    // had `t` in its deps). `enabled` lets always-mounted consumers (the wizard)
    // defer the fetch until they are actually shown.
    const { data, isLoading, isError } = useQuery({
        queryKey: importKeys.supportedParsers,
        queryFn: () => apiClient.getSupportedParsers(),
        staleTime: Infinity,
        enabled,
    });

    useEffect(() => {
        if (isError) toast.error(t("importPage.toast.parsersError"));
    }, [isError, t]);

    return {
        adapters: data ?? [],
        loading: isLoading,
        isError,
        isSuccess: data !== undefined,
    };
}
