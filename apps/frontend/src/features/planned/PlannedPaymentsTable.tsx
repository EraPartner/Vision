import { useMemo } from "react";
import { CalendarClock, CheckCircle2, Circle, Pencil, Repeat, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";

import { Money } from "@/components/shared/Money";
import { VirtualDataTable, type Column } from "@/components/shared/VirtualDataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { PlannedDueBadge } from "@/features/planned/PlannedDueBadge";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { cn } from "@/lib/utils";
import { safeHref } from "@/utils/safeHref";

const FREQUENCY_LABEL_KEYS: Record<string, string> = {
  daily: "plannedPage.freq.daily",
  weekly: "plannedPage.freq.weekly",
  biweekly: "plannedPage.freq.biweekly",
  monthly: "plannedPage.freq.monthly",
  quarterly: "plannedPage.freq.quarterly",
  yearly: "plannedPage.freq.yearly",
  custom: "plannedPage.freq.custom",
};

type PlannedPaymentRow = PlannedPayment & { _idx: number } & Record<string, unknown>;

interface PlannedPaymentsTableProps {
  payments: PlannedPayment[];
  totalCount: number;
  dateFormat: string;
  actionLoading: boolean;
  onRequestExecution: (payment: PlannedPayment) => void;
  onEdit: (payment: PlannedPayment) => void;
  onToggleActive: (payment: PlannedPayment) => void | Promise<void>;
  onDelete: (payment: PlannedPayment) => void | Promise<void>;
}

export function PlannedPaymentsTable({
  payments,
  totalCount,
  dateFormat,
  actionLoading,
  onRequestExecution,
  onEdit,
  onToggleActive,
  onDelete,
}: PlannedPaymentsTableProps) {
  const { t } = useLanguage();
  const rows = useMemo<PlannedPaymentRow[]>(
    () => payments.map((payment, index) => ({ ...payment, _idx: index })),
    [payments],
  );

  const columns = useMemo<Column<PlannedPaymentRow>[]>(() => [
    {
      key: "is_executed",
      header: "",
      editable: false,
      defaultWidth: 52,
      render: (row) => (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "icon-touch-target",
            row.is_executed
              ? "text-accent hover:text-accent"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={(event) => {
            event.stopPropagation();
            if (!row.is_executed) onRequestExecution(row);
          }}
          disabled={actionLoading || !row.is_active || row.is_executed}
          title={row.is_executed
            ? t("plannedPage.execute.linked", { n: row.executed_transaction_id ?? 0 })
            : t("plannedPage.execute.button")}
        >
          {row.is_executed
            ? <CheckCircle2 className="h-5 w-5" />
            : <Circle className="h-5 w-5" />}
        </Button>
      ),
    },
    {
      key: "name",
      header: t("plannedPage.col.payment"),
      editable: false,
      minWidth: 180,
      render: (row) => {
        const rowHref = safeHref(row.url);
        return (
          <div className="flex flex-col gap-0.5">
            <div className={cn(
              "font-medium flex items-center gap-2",
              !row.is_active || row.is_executed
                ? "text-muted-foreground line-through"
                : "text-foreground",
            )}>
              <span>{row.name}</span>
              {row.is_loan && (
                <Badge variant="secondary" className="eyebrow">
                  {t("plannedPage.loanBadge")}
                </Badge>
              )}
              {rowHref && (
                <a
                  href={rowHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  title={t("plannedPage.openLink")}
                  className="text-muted-foreground hover:text-primary"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-1.414 1.414a4 4 0 01-5.656-5.656l1.414-1.414" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7h6v6" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 3l-6 6" />
                  </svg>
                </a>
              )}
            </div>
            {row.recipient && <span className="text-xs text-muted-foreground">→ {row.recipient}</span>}
          </div>
        );
      },
    },
    {
      key: "amount",
      header: t("plannedPage.col.amount"),
      editable: false,
      defaultWidth: 120,
      render: (row) => (
        <span className={cn("font-semibold tabular-nums", row.amount < 0 ? "text-loss" : "text-gain")}>
          <Money amount={row.amount} currency={row.currency} signed />
        </span>
      ),
    },
    {
      key: "due_date",
      header: t("plannedPage.col.dueDate"),
      editable: false,
      defaultWidth: 130,
      render: (row) => <PlannedDueBadge dueDate={row.due_date} dateFormat={dateFormat} />,
    },
    {
      key: "is_recurring",
      header: t("plannedPage.col.recurrence"),
      editable: false,
      defaultWidth: 160,
      render: (row) => {
        if (row.is_loan && row.loan_term_months) {
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <Repeat className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm">{`loan(${row.loan_term_months} months)`}</span>
              </div>
              {(row.execution_count ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("plannedPage.executedCount", { n: row.execution_count ?? 0 })}
                </span>
              )}
            </div>
          );
        }

        return row.is_recurring ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Repeat className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm">
                {row.frequency === "custom" && row.custom_interval_days
                  ? t("plannedPage.everyNDays", { n: row.custom_interval_days })
                  : t(FREQUENCY_LABEL_KEYS[row.frequency ?? "monthly"])}
              </span>
            </div>
            {(row.execution_count ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                {t("plannedPage.executedCount", { n: row.execution_count ?? 0 })}
              </span>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{t("plannedPage.oneTime")}</span>
        );
      },
    },
    {
      key: "category",
      header: t("plannedPage.col.category"),
      editable: false,
      minWidth: 140,
      render: (row) => {
        const categoryLabel = typeof row.category === "string"
          ? row.category
          : row.category != null
            ? String(row.category)
            : "";
        return categoryLabel
          ? <Badge variant="outline" className="font-medium">{categoryLabel}</Badge>
          : <span className="text-muted-foreground text-sm">—</span>;
      },
    },
    {
      key: "is_active",
      header: t("plannedPage.col.status"),
      editable: false,
      defaultWidth: 130,
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "gap-1.5",
            row.is_active
              ? "text-accent hover:text-accent"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={async (event) => {
            event.stopPropagation();
            await onToggleActive(row);
          }}
          disabled={actionLoading}
        >
          {row.is_active
            ? <ToggleRight className="h-4 w-4" />
            : <ToggleLeft className="h-4 w-4" />}
          {row.is_active ? t("plannedPage.statusActive") : t("plannedPage.statusPaused")}
        </Button>
      ),
    },
    {
      key: "actions",
      header: "",
      editable: false,
      defaultWidth: 96,
      render: (row) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target text-muted-foreground hover:text-primary hover:bg-primary/10"
            onClick={(event) => {
              event.stopPropagation();
              onEdit(row);
            }}
            disabled={actionLoading}
            aria-label={t("aria.editPlannedPayment")}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            aria-label={t("aria.deletePlannedPayment")}
            onClick={async (event) => {
              event.stopPropagation();
              await onDelete(row);
            }}
            disabled={actionLoading}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ], [
    actionLoading,
    dateFormat,
    onDelete,
    onEdit,
    onRequestExecution,
    onToggleActive,
    t,
  ]);

  return (
    <VirtualDataTable
      title={t("plannedPage.tableTitle")}
      subtitle={t("plannedPage.tableSubtitle", { n: totalCount })}
      columns={columns}
      data={rows}
      emptyIcon={CalendarClock}
      emptyMessage={t("plannedPage.empty")}
    />
  );
}
