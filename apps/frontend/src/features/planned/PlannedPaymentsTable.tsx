import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import {
    ExternalLink,
    MoreHorizontal,
    Pause,
    Pencil,
    Play,
    Repeat,
    Trash2,
} from "lucide-react";

import { Money } from "@/components/shared/Money";
import {
    VirtualDataTable,
    type Column,
} from "@/components/shared/VirtualDataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
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

type PlannedPaymentRow = PlannedPayment & { _idx: number } & Record<
        string,
        unknown
    >;

interface PlannedPaymentsTableProps {
    payments: PlannedPayment[];
    totalCount: number;
    dateFormat: string;
    actionLoading: boolean;
    onRequestExecution: (payment: PlannedPayment) => void;
    onEdit: (payment: PlannedPayment) => void;
    onToggleActive: (payment: PlannedPayment) => void | Promise<void>;
    onDelete: (payment: PlannedPayment) => void | Promise<void>;
    /** Rendered instead of the rows when `payments` is empty. */
    emptyState?: ReactNode;
}

/**
 * The planned payments list (ADR-183): a worded "Mark as paid" action per row
 * and a ••• menu with Edit, Pause or Resume and Delete. A paused row carries a
 * Paused badge instead of a status column; a paid row links to the transaction
 * that paid it.
 */
export function PlannedPaymentsTable({
    payments,
    totalCount,
    dateFormat,
    actionLoading,
    onRequestExecution,
    onEdit,
    onToggleActive,
    onDelete,
    emptyState,
}: PlannedPaymentsTableProps) {
    const { t, tc } = useLanguage();
    const rows = useMemo<PlannedPaymentRow[]>(
        () => payments.map((payment, index) => ({ ...payment, _idx: index })),
        [payments],
    );

    const columns = useMemo<Column<PlannedPaymentRow>[]>(
        () => [
            {
                key: "name",
                header: t("plannedPage.col.payment"),
                editable: false,
                minWidth: 200,
                render: (row) => {
                    const rowHref = safeHref(row.url);
                    return (
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <div
                                className={cn(
                                    "flex min-w-0 items-center gap-2 type-body font-medium",
                                    !row.is_active || row.is_executed
                                        ? "text-label-secondary line-through"
                                        : "text-foreground",
                                )}
                            >
                                <span className="truncate">{row.name}</span>
                                {row.is_loan && (
                                    <Badge variant="secondary" size="sm">
                                        {t("plannedPage.loanBadge")}
                                    </Badge>
                                )}
                                {!row.is_active && (
                                    <Badge variant="muted" size="sm">
                                        {t("plannedPage.statusPaused")}
                                    </Badge>
                                )}
                                {rowHref && (
                                    <a
                                        href={rowHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(event) =>
                                            event.stopPropagation()
                                        }
                                        aria-label={`${t("plannedPage.openLink")}: ${row.name}`}
                                        title={`${t("plannedPage.openLink")}: ${row.name}`}
                                        className="shrink-0 rounded-chip text-label-secondary hover:text-primary focus-ring"
                                    >
                                        <ExternalLink
                                            className="h-3.5 w-3.5"
                                            aria-hidden
                                        />
                                    </a>
                                )}
                            </div>
                            {row.recipient && (
                                <span className="truncate type-footnote text-label-secondary">
                                    → {row.recipient}
                                </span>
                            )}
                        </div>
                    );
                },
            },
            {
                key: "amount",
                header: t("plannedPage.col.amount"),
                editable: false,
                defaultWidth: 130,
                render: (row) => (
                    <span
                        className={cn(
                            "font-semibold tabular-nums",
                            row.amount < 0 ? "text-foreground" : "text-gain",
                        )}
                    >
                        <Money
                            amount={row.amount}
                            currency={row.currency}
                            signed
                        />
                    </span>
                ),
            },
            {
                key: "due_date",
                header: t("plannedPage.col.dueDate"),
                editable: false,
                defaultWidth: 130,
                render: (row) => (
                    <PlannedDueBadge
                        dueDate={row.due_date}
                        dateFormat={dateFormat}
                    />
                ),
            },
            {
                key: "is_recurring",
                header: t("plannedPage.col.recurrence"),
                editable: false,
                defaultWidth: 160,
                render: (row) => {
                    const executed = (row.execution_count ?? 0) > 0 && (
                        <span className="type-footnote text-label-secondary">
                            {t("plannedPage.executedCount", {
                                n: row.execution_count ?? 0,
                            })}
                        </span>
                    );
                    if (row.is_loan && row.loan_term_months) {
                        return (
                            <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-1.5 type-body">
                                    <Repeat
                                        className="h-3.5 w-3.5 text-label-secondary"
                                        aria-hidden
                                    />
                                    <span>
                                        {tc(
                                            "plannedPage.loanTerm",
                                            row.loan_term_months,
                                        )}
                                    </span>
                                </div>
                                {executed}
                            </div>
                        );
                    }

                    return row.is_recurring ? (
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5 type-body">
                                <Repeat
                                    className="h-3.5 w-3.5 text-label-secondary"
                                    aria-hidden
                                />
                                <span>
                                    {row.frequency === "custom" &&
                                    row.custom_interval_days
                                        ? t("plannedPage.everyNDays", {
                                              n: row.custom_interval_days,
                                          })
                                        : t(
                                              FREQUENCY_LABEL_KEYS[
                                                  row.frequency ?? "monthly"
                                              ],
                                          )}
                                </span>
                            </div>
                            {executed}
                        </div>
                    ) : (
                        <span className="type-body text-label-secondary">
                            {t("plannedPage.oneTime")}
                        </span>
                    );
                },
            },
            {
                key: "category",
                header: t("plannedPage.col.category"),
                editable: false,
                minWidth: 140,
                render: (row) => {
                    const categoryLabel =
                        typeof row.category === "string"
                            ? row.category
                            : row.category != null
                              ? String(row.category)
                              : "";
                    return categoryLabel ? (
                        <Badge variant="outline">{categoryLabel}</Badge>
                    ) : (
                        <span className="type-body text-label-tertiary">—</span>
                    );
                },
            },
            {
                key: "is_executed",
                header: "",
                editable: false,
                defaultWidth: 150,
                render: (row) =>
                    row.is_executed ? (
                        <Badge variant="success">
                            {row.executed_transaction_id != null ? (
                                <Link
                                    to={`/transactions?transaction_id=${row.executed_transaction_id}`}
                                    onClick={(event) =>
                                        event.stopPropagation()
                                    }
                                    className="rounded-chip focus-ring"
                                >
                                    {t("plannedPage.execute.linked", {
                                        n: row.executed_transaction_id,
                                    })}
                                </Link>
                            ) : (
                                t("plannedPage.execute.linked", {
                                    n: row.executed_transaction_id ?? 0,
                                })
                            )}
                        </Badge>
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={(event) => {
                                event.stopPropagation();
                                onRequestExecution(row);
                            }}
                            disabled={actionLoading || !row.is_active}
                            aria-label={`${t("plannedPage.execute.button")}: ${row.name}`}
                        >
                            {t("plannedPage.execute.button")}
                        </Button>
                    ),
            },
            {
                key: "actions",
                header: "",
                editable: false,
                defaultWidth: 56,
                render: (row) => (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="icon-touch-target text-label-secondary hover:text-foreground"
                                disabled={actionLoading}
                                aria-label={t("plannedPage.rowMenu", {
                                    name: row.name,
                                })}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <MoreHorizontal className="h-4 w-4" aria-hidden />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => onEdit(row)}>
                                <Pencil
                                    className="mr-2 h-4 w-4 text-label-secondary"
                                    aria-hidden
                                />
                                {t("common.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => void onToggleActive(row)}
                            >
                                {row.is_active ? (
                                    <Pause
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                ) : (
                                    <Play
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                )}
                                {row.is_active
                                    ? t("plannedPage.pause")
                                    : t("plannedPage.resume")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => void onDelete(row)}
                            >
                                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                                {t("common.delete")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ),
            },
        ],
        [
            actionLoading,
            dateFormat,
            onDelete,
            onEdit,
            onRequestExecution,
            onToggleActive,
            t,
            tc,
        ],
    );

    return (
        <VirtualDataTable
            title={t("plannedPage.tableTitle")}
            subtitle={t("plannedPage.tableSubtitle", { n: totalCount })}
            columns={columns}
            data={rows}
            emptyMessage={emptyState ?? t("plannedPage.empty")}
            getRowLabel={(row) => row.name}
        />
    );
}
