import { useQuery } from "@tanstack/react-query";
import { safeHref } from "@/utils/safeHref";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import { RemoteNewsImage } from "@/components/shared/RemoteNewsImage";
import { apiClient } from "@/lib/api";
import { ProvenanceBadge } from "@/components/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/components/research/ResearchUnavailableNote";

interface ResearchNewsTabProps {
  symbol: string;
  enabled: boolean;
}

export function ResearchNewsTab({ symbol, enabled }: ResearchNewsTabProps) {
  const { t } = useLanguage();
  const loadingSurfaceProps = useLoadingSurfaceProps();
  const { appSettings } = useAppSettings();

  const { data: result, isFetching } = useQuery({
    queryKey: ["research-news", symbol],
    queryFn: () => apiClient.getResearchNews(symbol),
    enabled: enabled && !!symbol,
    staleTime: 2 * 60 * 60 * 1000,
  });

  if (isFetching && !result) {
    return (
      <div {...loadingSurfaceProps} className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-16 w-24 rounded shrink-0" />
            <div className="flex-1 space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-3 w-2/3" /></div>
          </div>
        ))}
      </div>
    );
  }

  if (result?.meta.source === "unavailable") {
    return <ResearchUnavailableNote provider={result.meta.provider} />;
  }

  const articles = result?.data.articles ?? [];
  if (articles.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">{t('market.noNews')}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end"><ProvenanceBadge meta={result?.meta} /></div>
      {articles.map((article) => {
        // A rejected link yields an inert, unfocusable anchor — render a plain
        // container for it rather than a row that keeps the hover treatment
        // while doing nothing on click. Working links are unchanged.
        const href = safeHref(article.link);
        const linkProps = href
          ? ({ href, target: "_blank", rel: "noopener noreferrer" } as const)
          : {};
        const Wrapper = href ? "a" : "div";
        return (
          <Wrapper
            key={article.link}
            {...linkProps}
            className={`flex gap-3 p-2 -mx-2 rounded-md${
              href ? " hover:bg-muted/70 transition-colors group" : ""
            }`}
          >
            {article.thumbnail && (
              <RemoteNewsImage
                src={article.thumbnail}
                alt={article.title}
                className="h-16 w-24 rounded shrink-0"
                fallbackClassName="hidden"
              />
            )}
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm font-medium text-foreground line-clamp-2${
                  href ? " group-hover:text-primary transition-colors" : ""
                }`}
              >
                {article.title}
              </p>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span>{article.publisher}</span>
                {article.publishedAt && (
                  <>
                    <span>·</span>
                    <span>{formatDateWithAppSettings(new Date(article.publishedAt), appSettings.dateFormat)}</span>
                  </>
                )}
                {href && (
                  <ExternalLink className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </div>
            </div>
          </Wrapper>
        );
      })}
    </div>
  );
}
