import type { QueryClient } from "@tanstack/react-query";
import { registerNativePaletteAnswerBridge, type NativePaletteWindow } from "@/lib/nativePaletteAnswer";
import { startNativeOverlayKeyboardBridge } from "@/lib/nativeShell";
import { registerNativeTaxReportProfileBridge, type NativeTaxReportWindow } from "@/lib/nativeTaxReportProfile";
import { registerNativeTaxReportContextBridge, type NativeTaxReportContextWindow } from "@/lib/nativeTaxReportContext";

export type NativeHelperWindow = NativePaletteWindow & NativeTaxReportWindow & NativeTaxReportContextWindow;

interface NativeHelperRuntimeOptions {
    queryClient: QueryClient;
    translate: (key: string) => string;
    target?: NativeHelperWindow;
    reportOverlayFailure?: (error: unknown) => void;
}

/** Owns the fixed source helpers without a framework dependency. The retained
 * React component still supplies the current runtime's mount and locale lifetime. */
export function startNativeHelperRuntime({
    queryClient,
    translate,
    target = window,
    reportOverlayFailure,
}: NativeHelperRuntimeOptions): () => void {
    const stopAnswers = registerNativePaletteAnswerBridge(queryClient, target);
    const stopTaxProfile = registerNativeTaxReportProfileBridge(target);
    const stopTaxContext = registerNativeTaxReportContextBridge(translate, target);
    const stopKeyboard = startNativeOverlayKeyboardBridge(target, reportOverlayFailure);
    return () => {
        stopAnswers();
        stopTaxProfile();
        stopTaxContext();
        stopKeyboard();
    };
}
