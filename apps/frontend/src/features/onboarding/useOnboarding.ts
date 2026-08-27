import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";

const ONBOARDING_KEY = "onboarding_complete";

export interface UseOnboardingResult {
    isComplete: boolean;
    isLoading: boolean;
    complete: () => void;
    reset: () => void;
}

export function useOnboarding(): UseOnboardingResult {
    const { t } = useLanguage();
    const [isComplete, setIsComplete] = useState(true);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        apiClient.getSetting(ONBOARDING_KEY)
            .then((result) => {
                if (!cancelled) setIsComplete(result?.value === true);
            })
            .catch(() => {
                if (!cancelled) setIsComplete(false);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const complete = useCallback(() => {
        setIsComplete(true);
        apiClient.saveSetting(ONBOARDING_KEY, true).catch((err) => {
            logger.error("Failed to persist onboarding completion", err);
            toast.error(t("onboarding.persist.failed"));
        });
    }, [t]);

    const reset = useCallback(() => {
        setIsComplete(false);
        apiClient.saveSetting(ONBOARDING_KEY, false).catch((err) => {
            logger.error("Failed to persist onboarding reset", err);
            toast.error(t("onboarding.persist.failed"));
        });
    }, [t]);

    return { isComplete, isLoading, complete, reset };
}
