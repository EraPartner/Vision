import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { aiKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import type { OllamaStatus } from '@/types/aiChat';

interface OllamaStatusBannerProps {
    status: OllamaStatus | undefined;
    isLoading: boolean;
}

const OLLAMA_SETUP_URL = 'https://ollama.com/download';

export function OllamaStatusBanner({ status, isLoading }: OllamaStatusBannerProps) {
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
            role="alert"
            className="flex items-start gap-3 border-b border-warning/30 bg-warning/10 px-5 py-3"
        >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                    {t('aiChat.banner.unreachable')}
                </p>
                <p className="mt-0.5 text-xs text-foreground/75">
                    {status?.error || t('aiChat.banner.hint')}
                    {shownUrl ? ` (${shownUrl})` : ''}
                </p>
                {status?.hint ? (
                    <p className="mt-1 text-xs text-foreground/85">
                        {status.hint}
                    </p>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetry}
                    className="h-7 border-warning/40 bg-transparent px-2 text-xs hover:bg-warning/20"
                >
                    <RefreshCw className="mr-1 h-3 w-3" />
                    {t('aiChat.banner.retry')}
                </Button>
                <a
                    href={OLLAMA_SETUP_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-warning/40 px-2 text-xs text-foreground hover:bg-warning/20"
                >
                    {t('aiChat.banner.setup')}
                    <ExternalLink className="h-3 w-3" />
                </a>
            </div>
        </div>
    );
}
