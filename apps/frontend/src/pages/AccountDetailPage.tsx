/**
 * /accounts/:id — the account ledger route (WP-B4, ADR-107 §3-addendum).
 *
 * Promotes the old AccountDetailSheet drawer to a full page: header (display
 * name · balance + provenance · drift chip → Reconcile · balance sparkline)
 * over the FULL running-balance ledger. First frontend consumer of the
 * backend's `include_balance=true` window (per-account partition, ADR-088).
 *
 * The running-balance window is computed server-side over the account's whole
 * filtered set ordered date ASC (independent of the date-DESC display sort),
 * so each row shows the balance AFTER that transaction and values stay correct
 * across Load-more pages. The `?since=YYYY-MM-DD` deep-link (Reconcile "show
 * transactions since {date}") narrows the view client-side — never via a
 * server date filter, which would truncate the window's history and produce
 * wrong balances.
 *
 * Account actions live in the header menu (relocated off the hub cards, WP-B4).
 * Lifecycle is deliberately two verbs (§3 F5): Edit… + Close (Archive folded
 * into Close; Reopen while closed), plus Delete only when the account has no
 * transactions — otherwise a disabled row routes the user to Close.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sparkline } from "@/components/charts";
import {
    ArchiveRestore,
    ArrowLeft,
    Coins,
    DoorClosed,
    GitMerge,
    Lock,
    MoreVertical,
    Pencil,
    Receipt,
    Trash2,
    X,
} from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { apiClient } from "@/lib/api";
import { transactionKeys } from "@/lib/queryKeys";
import {
    useAccounts,
    useUpdateAccount,
    useDeleteAccount,
} from "@/hooks/useAccounts";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useBalanceProvenance } from "@/features/accounts/balanceProvenance";
import { useDriftBadge } from "@/features/accounts/driftBadge";
import { isPortfolioType } from "@/features/accounts/groupAccounts";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    AddAccountDialog,
    type AccountFormValues,
} from "@/features/accounts/AddAccountDialog";
import {
    toAccountPayload,
    accountToFormValues,
} from "@/features/accounts/accountFormMapping";
import { MergeAccountDialog } from "@/features/accounts/MergeAccountDialog";
import { CloseAccountDialog } from "@/features/accounts/CloseAccountDialog";
import { OpeningBalanceDialog } from "@/features/accounts/OpeningBalanceDialog";
import { ReconcileDialog } from "@/features/accounts/ReconcileDialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Account } from "@/types/api";
import { Money } from "@/components/shared/Money";
import { PageShell } from "@/components/shared/PageShell";

// Same trend-color rule the AccountDetailSheet used.
const SPARK_COLOR_POSITIVE = "hsl(var(--gain))";
const SPARK_COLOR_NEGATIVE = "hsl(var(--loss))";
const SPARK_COLOR_NEUTRAL = "hsl(217, 91%, 60%)";

/** Ledger page size; Load more grows the window by this much. */
const LEDGER_PAGE_SIZE = 100;
/** Cap the sparkline to the most recent N rows so it stays a readable trend. */
const SPARKLINE_MAX_POINTS = 100;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function AccountDetailPage() {
    const { t, tc } = useLanguage();
    const { id } = useParams<{ id: string }>();
    const accountId = Number(id);
    const validId = Number.isInteger(accountId) && accountId > 0;
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const balanceProvenance = useBalanceProvenance();
    // Shared drift chip content + tone (§3 F1) — identical to the hub card.
    const driftBadge = useDriftBadge();
    const { appSettings } = useAppSettings();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    // The hub's cached population (active + archived) — the simplest source for
    // one account, and usually already warm from the hub navigation.
    const { data, isLoading, isError, error } = useAccounts({ active: "all" });
    const accounts = useMemo(() => data?.items ?? [], [data]);
    const account = validId
        ? accounts.find((a) => a.id === accountId)
        : undefined;

    const updateMutation = useUpdateAccount();
    const deleteMutation = useDeleteAccount();

    const [editing, setEditing] = useState(false);
    const [merging, setMerging] = useState(false);
    const [closing, setClosing] = useState(false);
    const [anchoring, setAnchoring] = useState(false);
    const [reconciling, setReconciling] = useState(false);
    const [ledgerLimit, setLedgerLimit] = useState(LEDGER_PAGE_SIZE);

    // Reconcile "show transactions since {date}" deep-link target — the exit the
    // ReconcileDialog navigates to (WP-B5).
    const sinceRaw = searchParams.get("since");
    const since = sinceRaw && YMD_RE.test(sinceRaw) ? sinceRaw : undefined;
    const clearSince = () =>
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.delete("since");
                return next;
            },
            { replace: true },
        );

    // Portfolio-type accounts keep their activity in portfolio_transactions —
    // there may still be ledger rows (broker cash), but no reconcile-cash story.
    const portfolio = account ? isPortfolioType(account.type) : false;
    const canViewTransactions = account?.has_transactions !== false;

    // FULL running-balance ledger, newest first. include_balance=true adds the
    // per-account SQL window (evaluated over the whole account before
    // LIMIT/OFFSET, ordered date ASC regardless of display sort) — WP-B4 is its
    // first frontend consumer. No server-side `since` filter: that would
    // restrict the window's input set and restate history from zero.
    const {
        data: txData,
        isLoading: txLoading,
        isError: txIsError,
        error: txError,
        isFetching,
        isPlaceholderData,
    } = useQuery({
        queryKey: transactionKeys.accountLedger(account?.id, ledgerLimit),
        queryFn: () =>
            apiClient.getTransactions({
                account_id: account!.id,
                limit: ledgerLimit,
                sort_by: "date",
                sort_dir: "desc",
                include_balance: true,
            }),
        enabled: !!account && canViewTransactions,
        staleTime: 30_000,
        placeholderData: (prev) => prev, // keep rows visible while Load more fetches
    });
    useBackgroundQueryCue(isFetching && isPlaceholderData);

    const rows = useMemo(() => txData?.items ?? [], [txData]);
    const total = txData?.total ?? 0;

    // ?since= narrowing (client-side). Rows are date-desc, so matches are a
    // prefix — plain YYYY-MM-DD string comparison, no Date parsing (and no
    // local-midnight shift).
    const visibleRows = useMemo(
        () =>
            since
                ? rows.filter(
                      (r) => (r.transaction_date ?? "").slice(0, 10) >= since,
                  )
                : rows,
        [rows, since],
    );

    // More rows exist server-side AND (unfiltered, or the since-window still
    // spans every loaded row — once an older-than-since row is loaded, the
    // date-desc prefix is complete and Load more can stop).
    const hasMore =
        rows.length < total && (!since || visibleRows.length === rows.length);

    // Oldest → newest running balances for the header trend line, most recent
    // window only. Prefer the computed running_balance; fall back to the
    // import-stamped balance column for older cached rows.
    const sparkPoints = useMemo(() => {
        return rows
            .slice(0, SPARKLINE_MAX_POINTS)
            .map((r) =>
                typeof r.running_balance === "number"
                    ? r.running_balance
                    : r.balance,
            )
            .filter((v): v is number => typeof v === "number")
            .reverse();
    }, [rows]);

    const sparkColor = useMemo(() => {
        if (sparkPoints.length < 2) return SPARK_COLOR_NEUTRAL;
        const delta = sparkPoints[sparkPoints.length - 1] - sparkPoints[0];
        return delta > 0
            ? SPARK_COLOR_POSITIVE
            : delta < 0
              ? SPARK_COLOR_NEGATIVE
              : SPARK_COLOR_NEUTRAL;
    }, [sparkPoints]);

    const handleSave = (values: AccountFormValues) => {
        if (!account) return;
        updateMutation.mutate(
            { id: account.id, data: toAccountPayload(values, "update") },
            { onSuccess: () => setEditing(false) },
        );
    };

    // Reopen a closed account. Note: the WP-A3 close semantics dropped it from
    // aggregates (in_net_worth=false) and reopening does NOT auto-restore that —
    // the user re-opts-in via Edit if wanted.
    const reopen = (a: Account) =>
        updateMutation.mutate({ id: a.id, data: { is_active: true } });

    const requestDelete = async (a: Account) => {
        const ok = await confirm({
            title: t("accounts.delete.title"),
            description: t("accounts.delete.description", {
                name: a.display_name || a.name,
            }),
            confirmLabel: t("common.delete"),
            variant: "destructive",
        });
        if (!ok) return;
        deleteMutation.mutate(a.id, {
            onSuccess: () => navigate("/accounts"),
            onError: (err) => {
                // Still referenced (409): route to the close flow instead of
                // dead-ending (lifecycle D5, ADR-088 addendum) — same as the hub.
                if ((err as { status?: number }).status === 409) {
                    toast.info(
                        t("accounts.delete.stillReferenced", {
                            name: a.display_name || a.name,
                        }),
                    );
                    setClosing(true);
                }
            },
        });
    };

    const openAccountTransactions = (a: Account) => {
        const params = new URLSearchParams({
            account_id: String(a.id),
            filter_label: a.display_name || a.name,
        });
        navigate(`/transactions?${params.toString()}`);
    };

    // ── Resolution states ───────────────────────────────────────────────────
    if (isLoading) {
        return <SectionLoader />;
    }
    if (isError) {
        return (
            <p className="text-sm text-destructive">
                {apiErrorToMessage(error, t)}
            </p>
        );
    }
    if (!account) {
        return (
            <EmptyState
                icon={PAGE_ICONS["/accounts"]}
                title={t("accounts.detail.notFoundTitle")}
                description={t("accounts.detail.notFoundDescription")}
                action={
                    <Button
                        variant="outline"
                        onClick={() => navigate("/accounts")}
                    >
                        <ArrowLeft className="mr-2 h-4 w-4" />{" "}
                        {t("accounts.detail.back")}
                    </Button>
                }
            />
        );
    }

    const a = account;
    const drift = driftBadge(a);
    const provenanceText = balanceProvenance(a);

    const metadata: Array<{ label: string; value: string }> = [
        {
            label: t("accounts.field.type"),
            value: t(`accounts.type.${a.type}`),
        },
        { label: t("accounts.field.currency"), value: a.currency },
        {
            label: t("accounts.field.owner"),
            value: t(`accounts.owner.${a.owner}`),
        },
        {
            label: t("accounts.field.liquidityClass"),
            value: t(`accounts.liquidity.${a.liquidity_class}`),
        },
        // tax_wrapper is consumer-less and hidden from the UI (§3 F7) — not shown here either.
        ...(a.institution
            ? [{ label: t("accounts.field.institution"), value: a.institution }]
            : []),
        {
            label: t("accounts.field.spendable"),
            value: a.spendable ? t("common.yes") : t("common.no"),
        },
        {
            label: t("accounts.field.inNetWorth"),
            value: a.in_net_worth ? t("common.yes") : t("common.no"),
        },
    ];

    const subtitleParts = [
        t(`accounts.type.${a.type}`),
        a.currency,
        a.institution,
    ].filter(Boolean);

    return (
        <PageShell className="">
            {/* Back to the hub */}
            <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-8 px-2 text-muted-foreground hover:text-foreground"
                onClick={() => navigate("/accounts")}
            >
                <ArrowLeft className="mr-1.5 h-4 w-4" />{" "}
                {t("accounts.detail.back")}
            </Button>

            <PageHeader
                title={a.display_name || a.name}
                subtitle={subtitleParts.join(" · ")}
                icon={PAGE_ICONS["/accounts"]}
                actions={
                    <>
                        {!a.is_active && (
                            <Badge variant="outline">
                                {t("accounts.archived")}
                            </Badge>
                        )}
                        {/* Edit / Merge / Close live HERE now (moved off the hub cards, WP-B4). */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    aria-label={t("accounts.actionsMenu")}
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    onClick={() => setEditing(true)}
                                >
                                    <Pencil className="mr-2 h-4 w-4" />{" "}
                                    {t("common.edit")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => setAnchoring(true)}
                                >
                                    <Coins className="mr-2 h-4 w-4" />{" "}
                                    {t("accounts.openingBalance.action")}
                                </DropdownMenuItem>
                                {canViewTransactions && (
                                    <DropdownMenuItem
                                        onClick={() =>
                                            openAccountTransactions(a)
                                        }
                                    >
                                        <Receipt className="mr-2 h-4 w-4" />{" "}
                                        {t("accounts.openTransactions")}
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                {accounts.length > 1 && (
                                    <DropdownMenuItem
                                        onClick={() => setMerging(true)}
                                    >
                                        <GitMerge className="mr-2 h-4 w-4" />{" "}
                                        {t("accounts.merge")}
                                    </DropdownMenuItem>
                                )}
                                {/* ONE lifecycle verb (§3 F5): Close (= archive + drop from
                                    aggregates, WP-A3) while active, Reopen while closed. */}
                                {a.is_active ? (
                                    <DropdownMenuItem
                                        onClick={() => setClosing(true)}
                                    >
                                        <DoorClosed className="mr-2 h-4 w-4" />{" "}
                                        {t("accounts.close.action")}
                                    </DropdownMenuItem>
                                ) : (
                                    <DropdownMenuItem onClick={() => reopen(a)}>
                                        <ArchiveRestore className="mr-2 h-4 w-4" />{" "}
                                        {t("accounts.restore")}
                                    </DropdownMenuItem>
                                )}
                                {/* Delete only exists for an account with no transactions;
                                    otherwise a disabled row explains the close route (§3 F5). */}
                                {a.has_transactions === false ? (
                                    <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={() => requestDelete(a)}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />{" "}
                                        {t("common.delete")}
                                    </DropdownMenuItem>
                                ) : (
                                    <DropdownMenuItem disabled>
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        <span className="flex flex-col">
                                            <span>{t("common.delete")}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {t(
                                                    "accounts.delete.hasTransactions",
                                                )}
                                            </span>
                                        </span>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                }
            />

            {/* Balance + provenance + drift + sparkline */}
            <Card>
                <CardContent
                    variant="headerless"
                    className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between"
                >
                    <div className="min-w-0">
                        <div className="eyebrow">
                            {t("accounts.detail.balance")}
                        </div>
                        {portfolio ? (
                            // Portfolio-type shells have no real cash value until
                            // WP-C5's holdings land — mirror the hub placeholder.
                            <div className="mt-1 text-lg font-medium text-muted-foreground">
                                {t("accounts.trackedInPortfolio")}
                            </div>
                        ) : a.computed_balance != null ? (
                            <>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div className="mt-1 text-3xl font-semibold tabular-nums">
                                            <Money
                                                amount={a.computed_balance}
                                                currency={a.currency}
                                            />
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {t("accounts.balanceTooltip")}
                                    </TooltipContent>
                                </Tooltip>
                                {provenanceText && (
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        {provenanceText}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="mt-1 text-sm text-muted-foreground">
                                {t("accounts.detail.noBalance")}
                            </div>
                        )}
                        {drift && (
                            // Drift chip → Reconcile (same affordance as the hub card badge).
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        className={`${badgeVariants({ variant: drift.variant })} mt-3 cursor-pointer text-xs`}
                                        aria-label={t(
                                            "accounts.reconcile.open",
                                        )}
                                        onClick={() => setReconciling(true)}
                                    >
                                        {drift.label}
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>{drift.tooltip}</TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                    {sparkPoints.length >= 2 && (
                        <div className="w-full shrink-0 sm:w-64">
                            <Sparkline
                                data={sparkPoints}
                                height={64}
                                color={sparkColor}
                                fillArea
                                strokeWidth={2}
                                ariaLabel={t("accounts.detail.sparklineAria")}
                            />
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Holdings placeholder — portfolio-type only; fed for real in WP-C5. */}
            {portfolio && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle
                            variant="sm"
                            className="flex items-center gap-2"
                        >
                            {t("accounts.detail.holdings")}
                            <Lock
                                className="h-3.5 w-3.5 text-muted-foreground"
                                aria-hidden
                            />
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="rounded-xl border border-dashed border-border/60 p-4">
                            <p className="text-sm text-muted-foreground">
                                {t("accounts.detail.holdingsDark")}
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Running-balance ledger */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <CardTitle variant="sm">
                            {t("accounts.detail.ledgerTitle")}
                        </CardTitle>
                        {canViewTransactions && total > 0 && (
                            <span className="text-xs text-muted-foreground">
                                {tc("accounts.detail.ledgerCount", total)}
                            </span>
                        )}
                    </div>
                </CardHeader>
                <CardContent className="space-y-3">
                    {since && (
                        <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2">
                            <span className="text-sm text-foreground">
                                {t("accounts.detail.sinceBanner", {
                                    date: formatDateStringWithAppSettings(
                                        since,
                                        appSettings.dateFormat,
                                    ),
                                })}
                            </span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="ml-auto h-6 w-6"
                                onClick={clearSince}
                                aria-label={t("aria.clearFilter")}
                            >
                                <X className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    )}

                    {!canViewTransactions ? (
                        <p className="text-sm text-muted-foreground">
                            {t("accounts.detail.noLedger")}
                        </p>
                    ) : txLoading ? (
                        <SectionLoader />
                    ) : txIsError ? (
                        <p className="text-sm text-destructive">
                            {apiErrorToMessage(txError, t)}
                        </p>
                    ) : visibleRows.length === 0 ? (
                        <p className="py-4 text-sm text-muted-foreground">
                            {t("accounts.detail.noTransactions")}
                        </p>
                    ) : (
                        <>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>
                                            {t("txPage.col.date")}
                                        </TableHead>
                                        <TableHead>
                                            {t("txPage.field.description")}
                                        </TableHead>
                                        <TableHead className="hidden md:table-cell">
                                            {t("txPage.col.category")}
                                        </TableHead>
                                        <TableHead className="text-right">
                                            {t("txPage.col.amount")}
                                        </TableHead>
                                        <TableHead className="text-right">
                                            {t("txPage.field.balance")}
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody
                                    className={cn(
                                        isPlaceholderData && "opacity-60",
                                    )}
                                >
                                    {visibleRows.map((txn) => (
                                        <TableRow key={txn.id}>
                                            <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                                                {formatDateStringWithAppSettings(
                                                    (
                                                        txn.transaction_date ??
                                                        ""
                                                    ).slice(0, 10),
                                                    appSettings.dateFormat,
                                                )}
                                            </TableCell>
                                            <TableCell className="max-w-[18rem]">
                                                <div className="truncate font-medium">
                                                    {txn.recipient_name ||
                                                        txn.memo ||
                                                        t(
                                                            "accounts.detail.unlabelled",
                                                        )}
                                                </div>
                                                {txn.recipient_name &&
                                                    txn.memo && (
                                                        <div className="truncate text-xs text-muted-foreground">
                                                            {txn.memo}
                                                        </div>
                                                    )}
                                            </TableCell>
                                            <TableCell className="hidden max-w-[10rem] truncate text-muted-foreground md:table-cell">
                                                {txn.category_name || "—"}
                                            </TableCell>
                                            <TableCell
                                                className={cn(
                                                    "whitespace-nowrap text-right tabular-nums",
                                                    txn.amount >= 0
                                                        ? "text-gain"
                                                        : "text-loss",
                                                )}
                                            >
                                                <Money
                                                    amount={txn.amount}
                                                    currency={
                                                        txn.currency ||
                                                        a.currency
                                                    }
                                                    signed
                                                />
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                                                {txn.running_balance != null ? (
                                                    <Money
                                                        amount={
                                                            txn.running_balance
                                                        }
                                                        currency={
                                                            txn.currency ||
                                                            a.currency
                                                        }
                                                    />
                                                ) : (
                                                    "—"
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                            {hasMore && (
                                <div className="flex justify-center pt-1">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={isPlaceholderData}
                                        onClick={() =>
                                            setLedgerLimit(
                                                (l) => l + LEDGER_PAGE_SIZE,
                                            )
                                        }
                                    >
                                        {t("accounts.detail.loadMore")}
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            {/* Metadata — the sheet's Details grid, kept on the page. */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle variant="sm">
                        {t("accounts.detail.details")}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                        {metadata.map((m) => (
                            <div key={m.label} className="flex flex-col">
                                <dt className="eyebrow">{m.label}</dt>
                                <dd className="tabular-nums">{m.value}</dd>
                            </div>
                        ))}
                    </dl>
                </CardContent>
            </Card>

            {/* Dialogs (all reused as-is) */}
            {editing && (
                <AddAccountDialog
                    key={a.id}
                    mode="edit"
                    open={editing}
                    onOpenChange={(o) => {
                        if (!o) setEditing(false);
                    }}
                    isSaving={updateMutation.isPending}
                    initialValues={accountToFormValues(a)}
                    onSave={handleSave}
                />
            )}
            {merging && (
                <MergeAccountDialog
                    source={a}
                    open={merging}
                    onOpenChange={(o) => {
                        if (!o) setMerging(false);
                    }}
                />
            )}
            {closing && (
                <CloseAccountDialog
                    account={a}
                    open={closing}
                    onOpenChange={(o) => {
                        if (!o) setClosing(false);
                    }}
                />
            )}
            {anchoring && (
                <OpeningBalanceDialog
                    key={a.id}
                    account={a}
                    open={anchoring}
                    onOpenChange={(o) => {
                        if (!o) setAnchoring(false);
                    }}
                />
            )}
            {reconciling && (
                <ReconcileDialog
                    key={a.id}
                    account={a}
                    open={reconciling}
                    onOpenChange={(o) => {
                        if (!o) setReconciling(false);
                    }}
                />
            )}

            <ConfirmDialog />
        </PageShell>
    );
}
