import { useEffect } from "react";
import { APPLE_FOUNDATION_MODEL } from "@vision/types/aiChat";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";

/** Wait for the page to settle before asking Ollama to load a model. */
const WARM_DELAY_MS = 2_000;
/** Under the backend's 10-minute keep_alive, so the model never unloads mid-use. */
const WARM_REFRESH_MS = 4 * 60_000;

function hint(action: "warm" | "release", model: string) {
    const request =
        action === "warm"
            ? apiClient.warmModel(model)
            : apiClient.releaseModel(model);
    // Residency is best-effort: the backend answers 204 even when it can't act.
    request.catch((error: unknown) => {
        logger.debug(`ai:model ${action} failed`, { model, error });
    });
}

/**
 * Keep the chat model loaded while the chat page is open and let it go when
 * the page is left or the model changes. Warms 2 s after mount, re-warms every
 * 4 minutes while the page is visible (one timer), and releases the previous
 * model on unmount. Does nothing for the Apple Foundation model or while
 * Ollama is not reachable.
 */
export function useModelResidency(model: string | null, ollamaOk: boolean) {
    useEffect(() => {
        if (!ollamaOk || model === null || model === APPLE_FOUNDATION_MODEL)
            return;
        let warmed = false;
        let refresh: ReturnType<typeof setInterval> | undefined;
        const warm = () => {
            warmed = true;
            hint("warm", model);
        };
        const first = setTimeout(() => {
            warm();
            refresh = setInterval(() => {
                if (document.visibilityState === "visible") warm();
            }, WARM_REFRESH_MS);
        }, WARM_DELAY_MS);
        return () => {
            clearTimeout(first);
            if (refresh !== undefined) clearInterval(refresh);
            // Releasing a model this page never warmed could only load it.
            if (warmed) hint("release", model);
        };
    }, [model, ollamaOk]);
}
