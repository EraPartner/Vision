import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { registerNativePaletteAnswerBridge } from "@/lib/nativePaletteAnswer";
import { startNativeOverlayKeyboardBridge } from "@/lib/nativeShell";
import logger from "@/lib/logger";
import { registerNativeTaxReportProfileBridge } from "@/lib/nativeTaxReportProfile";

export function NativePaletteAnswerBridge() {
    const queryClient = useQueryClient();
    useEffect(() => {
        const stopAnswers = registerNativePaletteAnswerBridge(queryClient);
        const stopTaxProfile = registerNativeTaxReportProfileBridge();
        const stopKeyboard = startNativeOverlayKeyboardBridge(undefined, (error) =>
            logger.warn("Native overlay request failed", error),
        );
        return () => {
            stopAnswers();
            stopTaxProfile();
            stopKeyboard();
        };
    }, [queryClient]);
    return null;
}
