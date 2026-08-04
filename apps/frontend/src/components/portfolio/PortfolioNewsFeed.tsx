import { useQuery } from "@tanstack/react-query";
import { safeHref } from "@/utils/safeHref";
import { apiClient, type MarketNewsArticle } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Newspaper, ExternalLink, Clock, WifiOff } from "lucide-react";
import { useLanguage } from '@/contexts/LanguageContext';
import { formatDistanceToNow } from "@/components/shared/dateUtils";
import { RemoteNewsImage } from "@/components/shared/RemoteNewsImage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

interface PortfolioNewsFeedProps {
  symbols: string[];
}

export function PortfolioNewsFeed({ symbols }: PortfolioNewsFeedProps) {
  const { t, language } = useLanguage();
  const isOnline = useOnlineStatus();
  const { data, isLoading, error } = useQuery({
    queryKey: ["market-news", symbols],
    queryFn: () => apiClient.getMarketNews(symbols.length > 0 ? symbols : undefined, 25),
    staleTime: 5 * 60 * 1000,
    refetchInterval: isOnline ? 10 * 60 * 1000 : false,
    refetchOnWindowFocus: false,
    retry: isOnline ? 1 : false,
    enabled: isOnline,
  });

  const articles = data ?? [];

  return (
    <Card className="glass-regular h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Newspaper className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">{t('newsFeed.title')}</CardTitle>
          {articles.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">
              {t('newsFeed.articles', { n: String(articles.length) })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0">
        <ScrollArea className="h-full">
          {/* Shared with the offline/empty/loaded branches, so the status role
              is spread only while loading — one region for the six skeleton
              rows rather than one per row. */}
          <div {...(isOnline && isLoading ? loadingSurfaceProps : {})} className="px-6 pb-4 space-y-1">
            {!isOnline && articles.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <WifiOff className="h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('newsFeed.offline')}
                </p>
              </div>
            )}

            {isOnline && isLoading && (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3 py-3 border-b border-border/50 last:border-0">
                  <Skeleton className="h-16 w-24 rounded-md shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))
            )}

            {isOnline && !isLoading && articles.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Newspaper className="h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {error ? t('newsFeed.unableToLoad') : t('newsFeed.noNews')}
                </p>
              </div>
            )}

            {articles.map((article) => (
              <NewsItem
                key={article.link || `${article.publishedAt ?? ""}-${article.title}`}
                article={article}
                locale={language}
              />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function NewsItem({ article, locale }: { article: MarketNewsArticle; locale: string }) {
  const timeAgo = article.publishedAt
    ? formatDistanceToNow(new Date(article.publishedAt), { addSuffix: true, locale })
    : null;

  // A link `safeHref` rejects yields an inert, unfocusable anchor. Render a
  // plain container for that case instead of a card that keeps the full hover
  // treatment while doing nothing on click. Working links are unchanged.
  const href = safeHref(article.link);
  const linkProps = href
    ? ({ href, target: "_blank", rel: "noopener noreferrer" } as const)
    : {};
  const Wrapper = href ? "a" : "div";

  return (
    <Wrapper
      {...linkProps}
      className={`flex gap-3 py-3 border-b border-border/50 last:border-0 -mx-2 px-2 rounded-md${
        href ? " group hover:bg-muted/50 transition-colors" : ""
      }`}
    >
      {article.thumbnail && (
        <RemoteNewsImage
          src={article.thumbnail}
          alt={article.title}
          className="h-16 w-24"
          fallbackClassName="hidden"
        />
      )}
      <div className="flex-1 min-w-0">
        <h4
          className={`text-sm font-medium text-foreground leading-snug line-clamp-2${
            href ? " group-hover:text-primary transition-colors" : ""
          }`}
        >
          {article.title}
          {href && (
            <ExternalLink className="inline-block h-3 w-3 ml-1 opacity-0 group-hover:opacity-60 transition-opacity" />
          )}
        </h4>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">{article.publisher}</span>
          {timeAgo && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {timeAgo}
              </span>
            </>
          )}
          {article.relatedSymbols.map((sym) => (
            <Badge key={sym} variant="outline" className="text-[10px] px-1.5 py-0 h-4">
              {sym}
            </Badge>
          ))}
        </div>
      </div>
    </Wrapper>
  );
}
