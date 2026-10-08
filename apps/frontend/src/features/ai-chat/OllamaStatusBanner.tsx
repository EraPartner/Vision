import { Info, ExternalLink, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { aiKeys } from "@/lib/queryKeys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
        <Alert role="status" className="mx-5 my-3 w-auto">
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>{t("aiChat.banner.unreachable")}</AlertTitle>
            <AlertDescription>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-48 flex-1">
                        <p className="type-callout text-label-secondary">
                            {t("aiChat.banner.hint")}
                        </p>
                        {(shownUrl || status?.hint) && (
                            <details className="mt-2 type-footnote text-label-secondary">
                                <summary className="w-fit cursor-pointer rounded-chip focus-ring">
                                    {t("aiChat.banner.connectionDetails")}
                                </summary>
                                {shownUrl && (
                                    <p className="mt-2 break-all">{shownUrl}</p>
                                )}
                                {status?.hint && (
                                    <p className="mt-1">{status.hint}</p>
                                )}
                            </details>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Button variant="outline" size="sm" onClick={handleRetry}>
                            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                            {t("aiChat.banner.retry")}
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                            <a
                                href={OLLAMA_SETUP_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {t("aiChat.banner.setup")}
                                <ExternalLink
                                    className="h-3.5 w-3.5"
                                    aria-hidden
                                />
                            </a>
                        </Button>
                    </div>
                </div>
            </AlertDescription>
        </Alert>
    );
}
