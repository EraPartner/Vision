import { Info, ExternalLink, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { aiKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { OllamaStatus } from "@/types/aiChat";

interface OllamaStatusBannerProps {
    status: OllamaStatus | undefined;
    isLoading: boolean;
}

const OLLAMA_SETUP_URL = "https://ollama.com/download";

export function OllamaStatusBanner({
    status,
    isLoading,
}: OllamaStatusBannerProps) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();

    if (isLoading) return null;
    if (status?.ok) return null;

    const handleRetry = () => {
        void queryClient.invalidateQueries({ queryKey: aiKeys.ollamaAll });
    };

    const shownUrl = status?.displayUrl || status?.baseUrl;

    return (
        <div
            role="status"
            className="flex flex-wrap items-start gap-3 border-b border-border/50 bg-muted/30 px-5 py-3"
        >
            <Info
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            />
            <div className="flex-1 min-w-48">
                <p className="text-sm font-medium text-foreground">
                    {t("aiChat.banner.unreachable")}
                </p>
                <p className="mt-0.5 text-xs text-foreground/75">
                    {t("aiChat.banner.hint")}
                </p>
                {(shownUrl || status?.hint) && (
                    <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="w-fit cursor-pointer rounded-sm focus-ring">
                            {t("aiChat.banner.connectionDetails")}
                        </summary>
                        {shownUrl && (
                            <p className="mt-2 break-all">{shownUrl}</p>
                        )}
                        {status?.hint && <p className="mt-1">{status.hint}</p>}
                    </details>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetry}
                    className="h-8 px-2 text-xs"
                >
                    <RefreshCw className="mr-1 h-3 w-3" />
                    {t("aiChat.banner.retry")}
                </Button>
                <a
                    href={OLLAMA_SETUP_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-ring inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-foreground hover:bg-muted"
                >
                    {t("aiChat.banner.setup")}
                    <ExternalLink className="h-3 w-3" />
                </a>
            </div>
        </div>
    );
}
