import { safeHref } from "@/utils/safeHref";
import { Skeleton } from "@/components/ui/skeleton";
import { List, ListRow } from "@/components/ui/list";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { RemoteNewsImage } from "@/components/shared/RemoteNewsImage";
import { ProvenanceBadge } from "@/features/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/features/research/ResearchUnavailableNote";
import { useResearchNewsQuery } from "./useResearchQueries";

interface ResearchNewsTabProps {
    symbol: string;
    enabled: boolean;
}

export function ResearchNewsTab({ symbol, enabled }: ResearchNewsTabProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();

    const { data: result, isFetching } = useResearchNewsQuery(symbol, enabled);

    if (isFetching && !result) {
        return (
            <div {...loadingSurfaceProps} className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex gap-3">
                        <Skeleton className="h-16 w-24 shrink-0" />
                        <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-3 w-2/3" />
                        </div>
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
        return (
            <p className="py-4 text-center type-callout text-label-secondary">
                {t("market.noNews")}
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <ProvenanceBadge meta={result?.meta} />
            </div>
            <List>
                {articles.map((article) => {
                    // A rejected link yields an inert row: the same content, but no
                    // activation and no external-link affordance.
                    const href = safeHref(article.link);
                    const meta = [
                        article.publisher,
                        article.publishedAt
                            ? formatDateWithAppSettings(
                                  new Date(article.publishedAt),
                                  appSettings.dateFormat,
                              )
                            : undefined,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    const leading = article.thumbnail ? (
                        <RemoteNewsImage
                            src={article.thumbnail}
                            alt=""
                            className="h-7 w-7 rounded-chip object-cover"
                            fallbackClassName="h-7 w-7 rounded-chip bg-muted"
                        />
                    ) : (
                        <span
                            aria-hidden="true"
                            className="h-7 w-7 rounded-chip bg-muted"
                        />
                    );
                    const title = (
                        <span className="whitespace-normal line-clamp-2 type-body text-foreground">
                            {article.title}
                        </span>
                    );
                    return href ? (
                        <ListRow
                            key={article.link}
                            asChild
                            leading={leading}
                            title={title}
                            subtitle={meta}
                            trailing={
                                <ExternalLink
                                    className="h-4 w-4 text-label-tertiary"
                                    aria-hidden="true"
                                />
                            }
                        >
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                            />
                        </ListRow>
                    ) : (
                        <ListRow
                            key={article.link}
                            leading={leading}
                            title={title}
                            subtitle={meta}
                        />
                    );
                })}
            </List>
        </div>
    );
}
