import { safeHref } from "@/utils/safeHref";
import type { MarketNewsArticle } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Newspaper, ExternalLink, Clock, WifiOff } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { formatDistanceToNow } from "@/lib/dateUtils";
import { RemoteNewsImage } from "@/components/shared/RemoteNewsImage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { EmptyState } from "@/components/shared/EmptyState";
import { usePortfolioNews } from "./usePortfolioQueries";

interface PortfolioNewsFeedProps {
    symbols: string[];
}

const MAX_VISIBLE_ARTICLES = 6;

export function PortfolioNewsFeed({ symbols }: PortfolioNewsFeedProps) {
    const { t, language } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const isOnline = useOnlineStatus();
    const { data, isLoading, error } = usePortfolioNews(
        symbols,
        MAX_VISIBLE_ARTICLES,
        isOnline,
    );

    const articles = (data ?? []).slice(0, MAX_VISIBLE_ARTICLES);

    return (
        <Card className="h-full flex flex-col">
            <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                    <CardTitle variant="sm">{t("newsFeed.title")}</CardTitle>
                    {articles.length > 0 && (
                        <Badge
                            variant="secondary"
                            size="sm"
                            className="ml-auto"
                        >
                            {t("newsFeed.articles", {
                                n: String(articles.length),
                            })}
                        </Badge>
                    )}
                </div>
            </CardHeader>
            <CardContent variant="flush" className="flex-1 min-h-0">
                <ScrollArea className="h-full">
                    {/* Shared with the offline/empty/loaded branches, so the status role
              is spread only while loading — one region for the six skeleton
              rows rather than one per row. */}
                    <div
                        {...(isOnline && isLoading ? loadingSurfaceProps : {})}
                        className="px-6 pb-4 space-y-1"
                    >
                        {!isOnline && articles.length === 0 && (
                            <EmptyState
                                headingLevel={3}
                                size="compact"
                                icon={WifiOff}
                                title={t("newsFeed.offline")}
                            />
                        )}

                        {isOnline &&
                            isLoading &&
                            Array.from({ length: 6 }).map((_, i) => (
                                <div
                                    key={i}
                                    className="flex gap-3 py-3 border-b border-border/50 last:border-0"
                                >
                                    <Skeleton className="h-16 w-24 shrink-0 rounded-control" />
                                    <div className="flex-1 space-y-2">
                                        <Skeleton className="h-4 w-full" />
                                        <Skeleton className="h-3 w-3/4" />
                                        <Skeleton className="h-3 w-1/3" />
                                    </div>
                                </div>
                            ))}

                        {isOnline && !isLoading && articles.length === 0 && (
                            <EmptyState
                                headingLevel={3}
                                size="compact"
                                icon={Newspaper}
                                title={
                                    error
                                        ? t("newsFeed.unableToLoad")
                                        : t("newsFeed.noNews")
                                }
                            />
                        )}

                        {articles.map((article) => (
                            <NewsItem
                                key={
                                    article.link ||
                                    `${article.publishedAt ?? ""}-${article.title}`
                                }
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

function NewsItem({
    article,
    locale,
}: {
    article: MarketNewsArticle;
    locale: string;
}) {
    const timeAgo = article.publishedAt
        ? formatDistanceToNow(new Date(article.publishedAt), {
              addSuffix: true,
              locale,
          })
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
            className={`-mx-2 flex gap-3 rounded-control border-b border-border/50 px-2 py-3 last:border-0${
                href
                    ? " group transition-colors hover:bg-foreground/[0.04]"
                    : ""
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
                    className={`line-clamp-2 type-body font-medium leading-snug text-foreground${
                        href
                            ? " group-hover:text-primary transition-colors"
                            : ""
                    }`}
                >
                    {article.title}
                    {href && (
                        <ExternalLink className="inline-block h-3 w-3 ml-1 opacity-0 group-hover:opacity-60 transition-opacity" />
                    )}
                </h4>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="type-caption text-label-secondary">
                        {article.publisher}
                    </span>
                    {timeAgo && (
                        <>
                            <span
                                className="text-label-tertiary"
                                aria-hidden="true"
                            >
                                ·
                            </span>
                            <span className="flex items-center gap-1 type-caption text-label-secondary">
                                <Clock className="h-3 w-3" />
                                {timeAgo}
                            </span>
                        </>
                    )}
                    {article.relatedSymbols.map((sym) => (
                        <Badge key={sym} variant="outline" size="sm">
                            {sym}
                        </Badge>
                    ))}
                </div>
            </div>
        </Wrapper>
    );
}
