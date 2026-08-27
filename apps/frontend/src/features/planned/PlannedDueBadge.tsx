import { differenceInDays, formatDateStringWithAppSettings, toYmd } from "@/components/shared/dateUtils";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { parsePlannedDueDate, toLocalMidnight } from "@/features/planned/plannedDueDate";

interface PlannedDueBadgeProps {
  dateFormat: string;
  dueDate?: string | null;
  today?: Date;
}

export function PlannedDueBadge({ dateFormat, dueDate, today = new Date() }: PlannedDueBadgeProps) {
  const { t } = useLanguage();
  const parsedDueDate = parsePlannedDueDate(dueDate);

  if (parsedDueDate.kind === "missing") {
    return <Badge variant="secondary">{t("plannedPage.due.noDate")}</Badge>;
  }
  if (parsedDueDate.kind === "invalid") {
    return <Badge variant="secondary">{t("plannedPage.due.invalid")}</Badge>;
  }

  const days = differenceInDays(parsedDueDate.date, toLocalMidnight(today));
  if (days === 0) {
    return <Badge className="bg-chart-3/20 text-chart-3 border-chart-3/30">{t("plannedPage.due.today")}</Badge>;
  }
  if (days < 0) {
    return <Badge variant="destructive">{t("plannedPage.due.overdue")}</Badge>;
  }
  if (days === 1) {
    return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">{t("plannedPage.due.tomorrow")}</Badge>;
  }
  if (days <= 7) {
    return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">{t("plannedPage.due.inDays", { n: days })}</Badge>;
  }
  return (
    <Badge variant="secondary">
      {formatDateStringWithAppSettings(toYmd(parsedDueDate.date), dateFormat)}
    </Badge>
  );
}
