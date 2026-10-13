import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { clearOnboardingDraft } from "./onboardingDraft";
import {
    hasNativeShellCapability,
    readNativeOnboardingState,
    subscribeNativeOnboarding,
} from "@/lib/nativeShell";

const ONBOARDING_KEY = "onboarding_complete";

export interface UseOnboardingResult {
    isComplete: boolean;
    isLoading: boolean;
    complete: () => void;
    reset: () => void;
}

export function useOnboarding(): UseOnboardingResult {
    const { t } = useLanguage();
    const [nativeOnboarding] = useState(() => hasNativeShellCapability("onboarding"));
    const [isComplete, setIsComplete] = useState(() =>
        nativeOnboarding ? readNativeOnboardingState().complete === true : true,
    );
    const [isLoading, setIsLoading] = useState(() =>
        nativeOnboarding ? readNativeOnboardingState().complete === null : true,
    );

    useEffect(() => {
        if (nativeOnboarding) {
            return subscribeNativeOnboarding((state) => {
                setIsComplete(state.complete === true);
                setIsLoading(state.complete === null);
            });
        }
        let cancelled = false;
        apiClient
            .getSetting(ONBOARDING_KEY)
            .then((result) => {
                if (!cancelled) setIsComplete(result?.value === true);
            })
            .catch(() => {
                if (!cancelled) setIsComplete(false);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [nativeOnboarding]);

    const complete = useCallback(() => {
        if (nativeOnboarding) return;
        setIsComplete(true);
        apiClient
            .saveSetting(ONBOARDING_KEY, true)
            .then(() => clearOnboardingDraft())
            .catch((err) => {
                logger.error("Failed to persist onboarding completion", err);
                toast.error(t("onboarding.persist.failed"));
            });
    }, [t, nativeOnboarding]);

    const reset = useCallback(() => {
        if (nativeOnboarding) return;
        clearOnboardingDraft();
        setIsComplete(false);
        apiClient.saveSetting(ONBOARDING_KEY, false).catch((err) => {
            logger.error("Failed to persist onboarding reset", err);
            toast.error(t("onboarding.persist.failed"));
        });
    }, [t, nativeOnboarding]);

    return { isComplete, isLoading, complete, reset };
}
