import { useLanguage } from "@/contexts/LanguageContext";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ResearchScorecard, ScorecardGrade, ScorecardSeverity } from "@/types/research";

/** Theme-token styling per severity (ok → risk). */
const SEVERITY_STYLE: Record<ScorecardSeverity, string> = {
  ok: "border-accent/30 text-accent bg-accent/5",
  caution: "border-warning/40 text-warning bg-warning/5",
  warn: "border-warning/60 text-warning bg-warning/10",
  risk: "border-destructive/50 text-destructive bg-destructive/10",
};

const SEVERITY_ICON: Record<ScorecardSeverity, React.ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  caution: TriangleAlert,
  warn: AlertTriangle,
  risk: ShieldAlert,
};

const GRADE_STYLE: Record<ScorecardGrade, string> = {
  strong: "text-accent border-accent/40 bg-accent/10",
  healthy: "text-accent border-accent/30 bg-accent/5",
  mixed: "text-warning border-warning/40 bg-warning/10",
  weak: "text-warning border-warning/60 bg-warning/15",
  poor: "text-destructive border-destructive/50 bg-destructive/10",
  unknown: "text-muted-foreground border-border bg-muted/40",
};

export function ScorecardGradeBadge({ scorecard, className }: { scorecard: ResearchScorecard; className?: string }) {
  const { t } = useLanguage();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        GRADE_STYLE[scorecard.grade],
        className,
      )}
    >
      {scorecard.score != null && <span className="tabular-nums">{scorecard.score}</span>}
      {t(`research.scorecard.grade.${scorecard.grade}`)}
    </span>
  );
}

/** Full panel: grade + score ring + severity counts + worst-first flag list. */
export function ScorecardPanel({ scorecard }: { scorecard: ResearchScorecard }) {
  const { t } = useLanguage();

  if (!scorecard || scorecard.evaluated === 0) {
    return <p className="py-2 text-sm text-muted-foreground">{t("research.scorecard.noData")}</p>;
  }

  const concerns = scorecard.flags.filter((f) => f.severity !== "ok");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ScorecardGradeBadge scorecard={scorecard} className="text-sm px-3 py-1" />
        <span className="text-xs text-muted-foreground">
          {t("research.scorecard.evaluated", { count: scorecard.evaluated })}
        </span>
        <div className="ml-auto flex gap-1.5">
          {(["risk", "warn", "caution"] as ScorecardSeverity[]).map((sev) =>
            scorecard.counts[sev] > 0 ? (
              <Badge key={sev} variant="outline" className={cn("text-[10px]", SEVERITY_STYLE[sev])}>
                {scorecard.counts[sev]} {t(`research.scorecard.severity.${sev}`)}
              </Badge>
            ) : null,
          )}
        </div>
      </div>

      {concerns.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-accent">
          <CheckCircle2 className="h-4 w-4" />
          {t("research.scorecard.allClear")}
        </p>
      ) : (
        <ul className="space-y-2">
          {concerns.map((flag) => {
            const Icon = SEVERITY_ICON[flag.severity];
            return (
              <li
                key={flag.metric}
                className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2", SEVERITY_STYLE[flag.severity])}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {t(`research.metric.${flag.metric}`)}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t("research.scorecard.benchmark", { value: flag.benchmark })}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{flag.reason}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
