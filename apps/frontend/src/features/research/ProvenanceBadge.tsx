import { Database, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { ResearchMeta } from "@/types/research";

interface ProvenanceBadgeProps {
    meta: ResearchMeta | undefined;
}

/**
 * A small badge reflecting the research response provenance (`meta.provider` /
 * `meta.source`). `unavailable` is handled separately by `ResearchUnavailableNote`,
 * so this renders nothing in that case.
 */
export function ProvenanceBadge({ meta }: ProvenanceBadgeProps) {
    const { t } = useLanguage();
    if (!meta || meta.source === "unavailable") return null;
    const isCache = meta.source === "cache";
    return (
        <Badge
            variant="outline"
            size="sm"
            className="gap-1 font-normal text-label-secondary"
        >
            {isCache ? (
                <Database className="h-3 w-3" aria-hidden="true" />
            ) : (
                <Radio className="h-3 w-3" aria-hidden="true" />
            )}
            <span>
                {isCache ? t("research.source.cache") : t("research.source.live")}
            </span>
            {meta.provider && (
                <span className="text-label-tertiary">· {meta.provider}</span>
            )}
        </Badge>
    );
}
