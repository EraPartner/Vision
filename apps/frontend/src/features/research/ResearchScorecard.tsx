import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { List, ListRow } from "@/components/ui/list";
import { cn } from "@/lib/utils";
import {
    AlertTriangle,
    CheckCircle2,
    ShieldAlert,
    TriangleAlert,
} from "lucide-react";
import type {
    ResearchScorecard,
    ScorecardGrade,
    ScorecardSeverity,
} from "@/types/research";

/** Role-token tone per severity (ok → risk). */
const SEVERITY_TEXT: Record<ScorecardSeverity, string> = {
    ok: "text-success",
    caution: "text-warning",
    warn: "text-warning",
    risk: "text-destructive",
};

const SEVERITY_BADGE: Record<ScorecardSeverity, BadgeProps["variant"]> = {
    ok: "success",
    caution: "warning",
    warn: "warning",
    risk: "destructive",
};

const SEVERITY_ICON: Record<
    ScorecardSeverity,
    React.ComponentType<{ className?: string }>
> = {
    ok: CheckCircle2,
    caution: TriangleAlert,
    warn: AlertTriangle,
    risk: ShieldAlert,
};

const GRADE_BADGE: Record<ScorecardGrade, BadgeProps["variant"]> = {
    strong: "success",
    healthy: "success",
    mixed: "warning",
    weak: "warning",
    poor: "destructive",
    unknown: "muted",
};

export function ScorecardGradeBadge({
    scorecard,
    className,
}: {
    scorecard: ResearchScorecard;
    className?: string;
}) {
    const { t } = useLanguage();
    return (
        <Badge
            variant={GRADE_BADGE[scorecard.grade]}
            className={cn("gap-1.5", className)}
        >
            {scorecard.score != null && (
                <span className="tabular-nums">{scorecard.score}</span>
            )}
            {t(`research.scorecard.grade.${scorecard.grade}`)}
        </Badge>
    );
}

/** Full panel: grade + severity counts + worst-first flag list. */
export function ScorecardPanel({ scorecard }: { scorecard: ResearchScorecard }) {
    const { t } = useLanguage();

    if (!scorecard || scorecard.evaluated === 0) {
        return (
            <p className="py-2 type-callout text-label-secondary">
                {t("research.scorecard.noData")}
            </p>
        );
    }

    const concerns = scorecard.flags.filter((f) => f.severity !== "ok");

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
                <ScorecardGradeBadge scorecard={scorecard} />
                <span className="type-footnote text-label-secondary">
                    {t("research.scorecard.evaluated", {
                        count: scorecard.evaluated,
                    })}
                </span>
                <div className="ml-auto flex gap-1.5">
                    {(["risk", "warn", "caution"] as ScorecardSeverity[]).map(
                        (sev) =>
                            scorecard.counts[sev] > 0 ? (
                                <Badge
                                    key={sev}
                                    variant={SEVERITY_BADGE[sev]}
                                    size="sm"
                                >
                                    {scorecard.counts[sev]}{" "}
                                    {t(`research.scorecard.severity.${sev}`)}
                                </Badge>
                            ) : null,
                    )}
                </div>
            </div>

            {concerns.length === 0 ? (
                <p className="flex items-center gap-2 type-callout text-success">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    {t("research.scorecard.allClear")}
                </p>
            ) : (
                <List>
                    {concerns.map((flag) => {
                        const Icon = SEVERITY_ICON[flag.severity];
                        // Prefer the localized message; fall back to the backend's English
                        // `reason` if a reasonKey has no i18n entry yet (t() returns the key on a miss).
                        const reasonI18nKey = `research.scorecard.reason.${flag.reasonKey}`;
                        const localizedReason = t(reasonI18nKey);
                        const reasonText =
                            localizedReason === reasonI18nKey
                                ? flag.reason
                                : localizedReason;
                        return (
                            <ListRow
                                key={flag.metric}
                                leading={
                                    <Icon
                                        className={cn(
                                            SEVERITY_TEXT[flag.severity],
                                        )}
                                        aria-label={t(
                                            `research.scorecard.severity.${flag.severity}`,
                                        )}
                                    />
                                }
                                title={t(`research.metric.${flag.metric}`)}
                                subtitle={reasonText}
                                trailing={
                                    <span className="type-footnote">
                                        {t("research.scorecard.benchmark", {
                                            value: flag.benchmark,
                                        })}
                                    </span>
                                }
                            />
                        );
                    })}
                </List>
            )}
        </div>
    );
}
