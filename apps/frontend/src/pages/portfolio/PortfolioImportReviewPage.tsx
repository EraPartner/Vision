/**
 * PortfolioImportReviewPage — resolve unmatched instruments and confirm a
 * portfolio import batch. Rows are grouped by investment; unmatched groups let
 * the user pick an existing holding or create a new one before committing.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useParams, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { InvestmentCombobox } from "@/features/portfolio/InvestmentCombobox";
import { PortfolioBrokerField } from "@/features/portfolio/PortfolioBrokerField";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";
import { accountLabel } from "@/features/accounts/groupAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, PlusCircle } from "lucide-react";
import { PageShell } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import type {
    PortfolioPreviewGroup,
    PortfolioPreviewRow,
} from "@/lib/api/portfolioImports";
import {
    portfolioImportPreviewKey,
    usePortfolioImportPreview,
} from "@/features/portfolio/usePortfolioQueries";

const PageIcon = PAGE_ICONS["/portfolio/import"];

/**
 * Seed height of a preview row (p-2 around a single line of footnote content
 * plus the type Badge). Every mounted row reports its real height through
 * `measureElement`, and the first one to do so becomes the estimate for the
 * rows that have not been mounted yet — so the page's total height (and with
 * it the scrollbar) does not drift as the user scrolls a long group.
 */
const PREVIEW_ROW_ESTIMATE = 38;
const RESOLVABLE_INSTRUMENT_ERROR =
    "unresolved instrument — pick or create a holding";

function isHoldingResolvable(row: PortfolioPreviewRow) {
    return (
        row.status === "matched" ||
        (row.status === "error" &&
            row.error_message === RESOLVABLE_INSTRUMENT_ERROR)
    );
}

/**
 * A group's preview rows. The page has no scroll container of its own — it
 * scrolls with the window — so this virtualizes against the window and
 * represents the rows outside the window as padding on the same box that used
 * to hold them all. Rows stay in normal flow (nothing absolutely positioned,
 * so a wrapping row can never overlap its neighbour) and keep their markup,
 * classes and separators: `divide-y` draws the separators between mounted
 * rows, and the topmost mounted row carries the one `divide-y` cannot draw
 * because it has no rendered predecessor.
 *
 * A multi-year brokerage import produces 500-2000+ rows across the groups; all
 * of them used to be mounted at once (`content-visibility` deferred their
 * paint, never their React/DOM cost).
 */
function PreviewRowList({ rows }: { rows: PortfolioPreviewRow[] }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [rowEstimate, setRowEstimate] = useState(PREVIEW_ROW_ESTIMATE);
    // Where this group's row box sits in the document: the window virtualizer
    // maps the window's scroll offset onto row indexes through it. Anything above
    // the group changing height — another group's rows settling onto their
    // measured height — moves it, hence the document-level ResizeObserver.
    const [scrollMargin, setScrollMargin] = useState(0);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => {
            const top = el.getBoundingClientRect().top + window.scrollY;
            setScrollMargin((prev) =>
                Math.abs(prev - top) > 0.5 ? top : prev,
            );
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(document.documentElement);
        window.addEventListener("resize", measure);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, []);

    const virtualizer = useWindowVirtualizer({
        count: rows.length,
        estimateSize: () => rowEstimate,
        overscan: 8,
        scrollMargin,
    });

    // Adopt the first mounted row's real height as the estimate for the rest.
    // Rows in a group are homogeneous, so this keeps the virtual total within a
    // pixel of the real one instead of letting it converge while scrolling.
    useLayoutEffect(() => {
        const first =
            containerRef.current?.querySelector<HTMLElement>("[data-index]");
        if (!first) return;
        const height = first.getBoundingClientRect().height;
        if (height > 0)
            setRowEstimate((prev) =>
                Math.abs(prev - height) > 0.5 ? height : prev,
            );
    }, [rows.length]);

    // `estimateSize` is not part of the measurements memo's key, so the adopted
    // estimate only takes effect once the virtualizer is told to re-measure.
    useLayoutEffect(() => {
        virtualizer.measure();
    }, [rowEstimate, virtualizer]);

    const items = virtualizer.getVirtualItems();
    const paddingTop = items.length ? items[0]!.start - scrollMargin : 0;
    const paddingBottom = items.length
        ? virtualizer.getTotalSize() -
          (items[items.length - 1]!.end - scrollMargin)
        : 0;

    return (
        <div
            ref={containerRef}
            className="divide-y divide-border/50 rounded-card corner-continuous border border-border/50 type-footnote"
            style={{ paddingTop, paddingBottom }}
        >
            {items.map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                    <div
                        key={row.id}
                        data-index={item.index}
                        ref={virtualizer.measureElement}
                        className={cn(
                            "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2",
                            item.index > 0 && "border-t border-border/50",
                        )}
                    >
                        <span className="tabular-nums text-label-secondary">
                            {row.tx_date}
                        </span>
                        <Badge variant="outline" size="sm">
                            {row.type ?? row.type_raw}
                        </Badge>
                        {row.units != null && (
                            <span className="tabular-nums">
                                {row.units} @ {row.price_per_unit ?? "—"}
                            </span>
                        )}
                        {row.amount != null && (
                            <span className="tabular-nums text-label-secondary">
                                {row.amount} {row.currency ?? ""}
                            </span>
                        )}
                        {row.status === "error" && row.error_message && (
                            <span className="text-destructive">
                                {row.error_message}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export function PortfolioImportReviewPage() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { batchId: batchIdParam } = useParams<{ batchId: string }>();
    const batchId = Number(batchIdParam);
    const [busyGroup, setBusyGroup] = useState<string | null>(null);
    const [repairAccountId, setRepairAccountId] = useState<number>();
    const { data: accountsData } = useAccounts({ active: "true" });
    const brokerAccounts = activeBrokerAccounts(accountsData?.items ?? []);

    const queryKey = portfolioImportPreviewKey(batchId);
    const { data, isLoading, error, refetch } =
        usePortfolioImportPreview(batchId);

    const commit = useMutation({
        mutationFn: (accountId?: number) =>
            apiClient.commitPortfolioImportBatch(batchId, accountId),
        onSuccess: (res) => {
            toast.success(
                t("portfolioImport.toast.importSuccess", {
                    n: res.imported,
                    dups: res.duplicates,
                }),
                {
                    icon: <CheckCircle2 className="h-4 w-4" />,
                },
            );
            // Replace, don't push: this batch is consumed, so Back must skip the
            // review URL (it no longer previews) instead of re-inviting a commit.
            navigate("/portfolio", { replace: true });
        },
        onError: (err: Error) =>
            toast.error(t("importPage.toast.serverError"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const groupKey = (g: PortfolioPreviewGroup) =>
        g.investment_id != null
            ? `inv:${g.investment_id}`
            : `raw:${(g.raw_symbol || g.raw_name || "?").toLowerCase()}`;

    const refresh = () => queryClient.invalidateQueries({ queryKey });

    const pickInvestment = async (
        g: PortfolioPreviewGroup,
        investmentId: number | null,
    ) => {
        if (investmentId == null) return;
        const rowIds = g.rows.filter(isHoldingResolvable).map((row) => row.id);
        if (!rowIds.length) return;
        setBusyGroup(groupKey(g));
        try {
            await apiClient.overridePortfolioImportRows(batchId, rowIds, {
                investmentId,
            });
            await refresh();
        } catch (err) {
            toast.error(t("importPage.toast.serverError"), {
                description: apiErrorToMessage(err, t),
            });
        } finally {
            setBusyGroup(null);
        }
    };

    const createNew = async (g: PortfolioPreviewGroup) => {
        const rowIds = g.rows.filter(isHoldingResolvable).map((row) => row.id);
        if (!rowIds.length) return;
        setBusyGroup(groupKey(g));
        try {
            await apiClient.overridePortfolioImportRows(batchId, rowIds, {
                createNew: true,
            });
            await refresh();
            toast.success(t("portfolioImport.toast.holdingCreated"));
        } catch (err) {
            toast.error(t("importPage.toast.serverError"), {
                description: apiErrorToMessage(err, t),
            });
        } finally {
            setBusyGroup(null);
        }
    };

    if (isLoading) {
        return (
            <PageShell className="mx-auto max-w-3xl">
                <PageHeader
                    title={t("portfolioImport.review.title")}
                    subtitle={t("portfolioImport.review.subtitle")}
                    icon={PageIcon}
                />
                <Skeleton className="h-12 w-full rounded-card" />
                <Skeleton className="h-48 w-full rounded-card" />
            </PageShell>
        );
    }
    if (error || !data) {
        return (
            <PageShell className="mx-auto max-w-3xl">
                <PageHeader
                    title={t("portfolioImport.review.title")}
                    icon={PageIcon}
                />
                <PageError
                    title={t("importPage.failed")}
                    message={
                        error ? apiErrorToMessage(error, t) : t("common.error")
                    }
                    onRetry={() => void refetch()}
                />
            </PageShell>
        );
    }

    const unresolvedCount = data.totals.unresolved + data.totals.error;
    const hasRepairableCashError = data.groups.some(
        (group) =>
            group.is_cash &&
            group.rows.some(
                (row) =>
                    row.status === "error" &&
                    row.error_message ===
                        "brokerage cash row requires a batch account",
            ),
    );
    const needsAccountRepair =
        hasRepairableCashError ||
        (data.account_id != null && !data.account_valid);
    const tradeCount = data.groups
        .filter((group) => !group.is_cash)
        .reduce((sum, group) => sum + group.row_count, 0);
    const repairAccount = brokerAccounts.find(
        (account) => account.id === repairAccountId,
    );
    const routingAccountName = repairAccount
        ? accountLabel(repairAccount)
        : data.account_name;
    const routingKey =
        tradeCount === 1
            ? "portfolioImport.review.routingBrokerOne"
            : "portfolioImport.review.routingBroker";
    const unassignedRoutingKey =
        tradeCount === 1
            ? "portfolioImport.review.routingUnassignedOne"
            : "portfolioImport.review.routingUnassigned";
    const routingUnavailable = needsAccountRepair && !repairAccount;

    return (
        <PageShell className="mx-auto max-w-3xl">
            <PageHeader
                title={t("portfolioImport.review.title")}
                subtitle={t("portfolioImport.review.subtitle")}
                icon={PageIcon}
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">
                            {t("portfolioImport.review.matched", {
                                n: data.totals.symbol + data.totals.name_exact,
                            })}
                        </Badge>
                        {unresolvedCount > 0 && (
                            <Badge variant="warning">
                                {t("portfolioImport.review.unresolved", {
                                    n: unresolvedCount,
                                })}
                            </Badge>
                        )}
                    </div>
                }
            />

            <Alert variant={routingUnavailable ? "warning" : "default"}>
                {routingUnavailable && <AlertTriangle className="h-4 w-4" />}
                <AlertDescription>
                    {routingUnavailable
                        ? t("portfolioImport.review.routingUnavailable")
                        : routingAccountName
                          ? t(routingKey, {
                                count: tradeCount,
                                broker: routingAccountName,
                            })
                          : t(unassignedRoutingKey, {
                                count: tradeCount,
                            })}
                </AlertDescription>
            </Alert>

            {data.groups.map((g) => {
                const key = groupKey(g);
                const hasResolvableRows = g.rows.some(isHoldingResolvable);
                // Brokerage cash group (ADR-095): no instrument to resolve — it commits as
                // plain cash transactions on the batch's sleeve.
                const resolved = g.is_cash || g.investment_id != null;
                const busy = busyGroup === key;
                return (
                    <Card
                        key={key}
                        className={cn(!resolved && "!border-warning/40")}
                    >
                        <CardHeader>
                            <CardTitle
                                variant="sm"
                                className="flex flex-wrap items-center gap-2"
                            >
                                {!resolved && (
                                    <AlertTriangle
                                        className="h-4 w-4 text-warning"
                                        aria-hidden
                                    />
                                )}
                                <span className="min-w-0 truncate">
                                    {g.is_cash
                                        ? t(
                                              "portfolioImport.review.cashMovements",
                                          )
                                        : resolved
                                          ? g.investment_symbol
                                              ? `${g.investment_name} (${g.investment_symbol})`
                                              : g.investment_name
                                          : g.raw_symbol ||
                                            g.raw_name ||
                                            t(
                                                "portfolioImport.review.unknownInstrument",
                                            )}
                                </span>
                                <Badge variant="secondary" size="sm">
                                    {g.row_count}
                                </Badge>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {!g.is_cash && hasResolvableRows && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="type-footnote text-label-secondary">
                                        {t("portfolioImport.review.holding")}
                                    </span>
                                    <InvestmentCombobox
                                        value={g.investment_id}
                                        onSelect={(id) => pickInvestment(g, id)}
                                        disabled={busy}
                                    />
                                    {!resolved && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => createNew(g)}
                                            disabled={busy}
                                        >
                                            {busy ? (
                                                <Loader2 className="animate-spin" />
                                            ) : (
                                                <PlusCircle />
                                            )}
                                            {t(
                                                "portfolioImport.review.createNew",
                                            )}
                                        </Button>
                                    )}
                                </div>
                            )}

                            <PreviewRowList rows={g.rows} />
                        </CardContent>
                    </Card>
                );
            })}

            <Card>
                <CardContent
                    variant="compact"
                    className="flex flex-wrap items-end justify-between gap-3"
                >
                    {needsAccountRepair ? (
                        <div className="flex flex-col gap-1.5">
                            <span className="type-footnote text-label-secondary">
                                {t("portfolioImport.review.cashAccount")}
                            </span>
                            <PortfolioBrokerField
                                id="portfolio-import-repair-account"
                                accounts={brokerAccounts}
                                value={
                                    repairAccountId == null
                                        ? undefined
                                        : String(repairAccountId)
                                }
                                onChange={(value) =>
                                    setRepairAccountId(
                                        value ? Number(value) : undefined,
                                    )
                                }
                                t={t}
                            />
                        </div>
                    ) : (
                        <span />
                    )}
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            onClick={() => navigate("/portfolio")}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            onClick={() => commit.mutate(repairAccountId)}
                            disabled={
                                commit.isPending ||
                                (needsAccountRepair && repairAccountId == null)
                            }
                        >
                            {commit.isPending ? (
                                <Loader2 className="animate-spin" />
                            ) : (
                                <CheckCircle2 />
                            )}
                            {t("portfolioImport.review.commit")}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </PageShell>
    );
}

export default PortfolioImportReviewPage;
