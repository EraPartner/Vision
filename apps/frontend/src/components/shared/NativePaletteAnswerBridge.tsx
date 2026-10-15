import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startNativeHelperRuntime } from "@/lib/nativeHelperRuntime";
import logger from "@/lib/logger";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export function NativePaletteAnswerBridge() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();
    const translate = useRef(t);
    translate.current = t;
    useEffect(() => {
        return startNativeHelperRuntime({
            queryClient,
            translate: (key) => translate.current(key),
            reportOverlayFailure: (error) => logger.warn("Native overlay request failed", error),
        });
    }, [queryClient]);
    return null;
}
