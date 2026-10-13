import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { registerNativePaletteAnswerBridge } from "@/lib/nativePaletteAnswer";
import { startNativeOverlayKeyboardBridge } from "@/lib/nativeShell";
import logger from "@/lib/logger";
import { registerNativeTaxReportProfileBridge } from "@/lib/nativeTaxReportProfile";
import { registerNativeTaxReportContextBridge } from "@/lib/nativeTaxReportContext";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export function NativePaletteAnswerBridge() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();
    const translate = useRef(t);
    translate.current = t;
    useEffect(() => {
        const stopAnswers = registerNativePaletteAnswerBridge(queryClient);
        const stopTaxProfile = registerNativeTaxReportProfileBridge();
        const stopTaxContext = registerNativeTaxReportContextBridge((key) => translate.current(key));
        const stopKeyboard = startNativeOverlayKeyboardBridge(undefined, (error) =>
            logger.warn("Native overlay request failed", error),
        );
        return () => {
            stopAnswers();
            stopTaxProfile();
            stopTaxContext();
            stopKeyboard();
        };
    }, [queryClient]);
    return null;
}
