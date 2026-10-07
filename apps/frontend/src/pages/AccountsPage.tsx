import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Link } from "react-router";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list";
import { Skeleton } from "@/components/ui/skeleton";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
    Bitcoin,
    ChevronRight,
    CreditCard,
    Landmark,
    MoreHorizontal,
    PanelRight,
    PiggyBank,
    Receipt,
    Scale,
    ShieldCheck,
    TrendingUp,
    Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useBalanceProvenance } from "@/features/accounts/balanceProvenance";
import { useDriftBadge } from "@/features/accounts/driftBadge";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    groupAccounts,
    sumConvertedBalances,
    computeNetCash,
    isHoldingsOnlyPortfolioType,
    isPortfolioType,
    type AccountGroup,
} from "@/features/accounts/groupAccounts";
import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { ReconcileDialog } from "@/features/accounts/ReconcileDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { Account, AccountType } from "@/types/api";
import { Money } from "@/components/shared/Money";
import { PageShell } from "@/components/shared/PageShell";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { getBrokerAccountMetrics } from "@/features/accounts/brokerAccountMetrics";

const TYPE_ICON: Record<AccountType, LucideIcon> = {
    checking: Landmark,
    savings: PiggyBank,
    brokerage: TrendingUp,
    crypto_exchange: Bitcoin,
    wallet: Wallet,
    pension: ShieldCheck,
    liability: CreditCard,
};

/** Keeps a control nested in the row link from activating the row. */
const stopRowActivation = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
};

/**
 * Accounts (completeness sweep): one grouped list per account group with the
 * whole row linking to the ledger, a row ••• menu for the secondary routes
 * and the drift chip opening Reconcile in place. Net cash closes the page as
 * its own card; Archived stays a collapsed group.
 */
export default function AccountsPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    // Archived is a (collapsed) group now, not a toggle (WP-B3) — always fetch
    // the full population.
    const { data, isLoading, isError, error, refetch } = useAccounts({
        active: "all",
    });
    const balanceProvenance = useBalanceProvenance();
    // Drift badge text + tone (§3 F1) — shared with the detail header and the
    // dashboard widget so wording and the stale threshold can't diverge.
    const driftBadge = useDriftBadge();
    const { appSettings } = useAppSettings();
    const displayCurrency = appSettings.defaultCurrency || "EUR";
    const { convertToTarget } = useCurrencyConverter(displayCurrency);
    const portfolioSummaryQuery = usePortfolioSummaryQuery(displayCurrency);
    const portfolioSummary = portfolioSummaryQuery.data;
    const [archivedOpen, setArchivedOpen] = useState(false);

    // Only Reconcile remains a hub-level dialog (WP-B4): Edit / Merge / Close /
    // Opening balance / Archive / Delete moved to the /accounts/:id header menu.
    const [reconciling, setReconciling] = useState<Account | undefined>(
        undefined,
    );

    const accounts = useMemo(() => data?.items ?? [], [data]);

    // Deterministic grouped structure (WP-B3): Cash & Savings · Portfolio
    // accounts · Liabilities · Archived (collapsed), label-sorted per group.
    const groups = useMemo(() => groupAccounts(accounts), [accounts]);
    const visibleGroups = useMemo(
        () => groups.filter((g) => g.id !== "archived"),
        [groups],
    );
    const archivedGroup = useMemo(
        () => groups.find((g) => g.id === "archived"),
        [groups],
    );
    // Grand line: WP-A1's Liquid + Liabilities population (in_net_worth only,
    // active, portfolio-type ledger balances excluded until WP-C5).
    const netCash = useMemo(
        () => computeNetCash(accounts, convertToTarget),
        [accounts, convertToTarget],
    );
    const netCashIncomplete = useMemo(
        () =>
            accounts.some(
                (account) =>
                    account.is_active &&
                    account.in_net_worth &&
                    !isPortfolioType(account.type) &&
                    account.balance_incomplete,
            ),
        [accounts],
    );

    // Filter by the account entity's id (ADR-088) — reads key on the FK, not
    // the retiring bank_account string.
    const accountTransactionsHref = (a: Account) => {
        const params = new URLSearchParams({
            account_id: String(a.id),
            filter_label: a.display_name || a.name,
        });
        return `/transactions?${params.toString()}`;
    };

    const renderAccountRow = (a: Account) => {
        const label = a.display_name || a.name;
        const holdingsOnly = isHoldingsOnlyPortfolioType(a.type);
        // Wallets and exchanges have no cash sleeve or ledger workflow. Broker
        // accounts can still expose imported cash transactions.
        const canViewTransactions =
            !holdingsOnly && a.has_transactions !== false;
        // Provenance subline (WP-B2): where the computed balance comes
        // from — stamped statement anchor + entries since, or plain sum.
        const provenanceText = balanceProvenance(a);
        // Portfolio-type rows have no real cash value until WP-C5's holdings
        // land — a "€0,00" computed ledger balance is misleading, so show the
        // holdings figure or a placeholder instead (§3 F8).
        const portfolioPlaceholder = isPortfolioType(a.type);
        const portfolioMetrics = portfolioPlaceholder
            ? getBrokerAccountMetrics(portfolioSummary, a.id)
            : undefined;
        // Drift chip content: "Drift +€15,50 · statement 03/06/2026", in warning
        // tone once that statement reading is older than ~45 days (§3 F1).
        const drift = holdingsOnly ? undefined : driftBadge(a);
        const canReconcile =
            !holdingsOnly && (!!drift || a.multi_currency_cash);
        const Icon = TYPE_ICON[a.type] ?? Landmark;

        const metaParts: ReactNode[] = [
            <span key="type">{t(`accounts.type.${a.type}`)}</span>,
            <span key="currency">{a.currency}</span>,
        ];
        if (a.institution)
            metaParts.push(<span key="institution">{a.institution}</span>);

        const subtitle = (
            <>
                <span className="block truncate">
                    {metaParts.map((part, index) => (
                        <span key={index}>
                            {index > 0 && <span aria-hidden="true"> · </span>}
                            {part}
                        </span>
                    ))}
                </span>
                {portfolioPlaceholder
                    ? !holdingsOnly &&
                      a.computed_balance != null && (
                          <span className="block truncate">
                              {t("accounts.portfolio.cash")}{" "}
                              <Money
                                  amount={a.computed_balance}
                                  currency={a.currency}
                              />
                              {provenanceText && (
                                  <span> · {provenanceText}</span>
                              )}
                          </span>
                      )
                    : a.computed_balance != null &&
                      provenanceText && (
                          <span className="block truncate">
                              {provenanceText}
                          </span>
                      )}
                {!portfolioPlaceholder && a.balance_incomplete && (
                    <>
                        <span className="block truncate text-warning">
                            {t("accounts.balanceIncomplete")}
                        </span>
                        {a.balance_parts
                            ?.filter((part) =>
                                a.unconverted_currencies?.includes(
                                    part.currency,
                                ),
                            )
                            .map((part) => (
                                <span
                                    key={part.currency}
                                    className="block truncate text-warning"
                                >
                                    <Money
                                        amount={part.balance}
                                        currency={part.currency}
                                    />{" "}
                                    {t("accounts.balanceExcluded")}
                                </span>
                            ))}
                    </>
                )}
            </>
        );

        const value = portfolioPlaceholder ? (
            <span className="flex flex-col items-end text-right">
                {portfolioMetrics?.hasPosition ? (
                    <>
                        <span className="font-medium text-foreground">
                            <Money
                                amount={portfolioMetrics.holdingsValue}
                                currency={displayCurrency}
                            />
                        </span>
                        <span className="type-caption text-label-tertiary">
                            {t("accounts.portfolio.holdings")}
                        </span>
                        <span
                            className={cn(
                                "type-footnote",
                                portfolioMetrics.gainLoss > 0
                                    ? "text-gain"
                                    : portfolioMetrics.gainLoss < 0
                                      ? "text-loss"
                                      : "text-label-secondary",
                            )}
                        >
                            {t("accounts.portfolio.pnl")}{" "}
                            <Money
                                amount={portfolioMetrics.gainLoss}
                                currency={displayCurrency}
                                signed
                            />
                        </span>
                    </>
                ) : (
                    <span className="type-footnote text-label-secondary">
                        {portfolioMetrics
                            ? t("accounts.portfolio.noAssignedHoldings")
                            : t("accounts.trackedInPortfolio")}
                    </span>
                )}
            </span>
        ) : a.computed_balance != null ? (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="font-medium text-foreground">
                        <Money
                            amount={a.computed_balance}
                            currency={a.currency}
                        />
                    </span>
                </TooltipTrigger>
                <TooltipContent>{t("accounts.balanceTooltip")}</TooltipContent>
            </Tooltip>
        ) : null;

        return (
            <ListRow
                key={a.id}
                asChild
                className={cn(!a.is_active && "opacity-60")}
                leading={<Icon />}
                title={
                    <span className="inline-flex max-w-full items-center gap-2">
                        <span className="truncate">{label}</span>
                        {!a.is_active && (
                            <Badge variant="outline" size="sm">
                                {t("accounts.archived")}
                            </Badge>
                        )}
                        {!a.in_net_worth && (
                            <Badge
                                variant="outline"
                                size="sm"
                                className="font-normal text-label-secondary"
                            >
                                {t("accounts.notInNetWorth")}
                            </Badge>
                        )}
                    </span>
                }
                subtitle={subtitle}
                trailing={
                    <>
                        {drift && (
                            // Clicking the drift chip opens the reconcile dialog
                            // (statement vs computed + delta → accept / adjust).
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        className={badgeVariants({
                                            variant: drift.variant,
                                        })}
                                        aria-label={t(
                                            "accounts.reconcile.open",
                                        )}
                                        onClick={(event) => {
                                            stopRowActivation(event);
                                            setReconciling(a);
                                        }}
                                    >
                                        {drift.label}
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>{drift.tooltip}</TooltipContent>
                            </Tooltip>
                        )}
                        {value}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-label-secondary"
                                    aria-label={t("accounts.rowMenu", {
                                        name: label,
                                    })}
                                    onClick={stopRowActivation}
                                >
                                    <MoreHorizontal aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="end"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <DropdownMenuItem asChild>
                                    <Link to={`/accounts/${a.id}`}>
                                        <PanelRight className="mr-2 h-4 w-4 text-label-secondary" />
                                        {t("accounts.viewDetails")}
                                    </Link>
                                </DropdownMenuItem>
                                {canViewTransactions && (
                                    <DropdownMenuItem asChild>
                                        <Link to={accountTransactionsHref(a)}>
                                            <Receipt className="mr-2 h-4 w-4 text-label-secondary" />
                                            {t("accounts.openTransactions")}
                                        </Link>
                                    </DropdownMenuItem>
                                )}
                                {canReconcile && (
                                    <DropdownMenuItem
                                        onSelect={() => setReconciling(a)}
                                    >
                                        <Scale className="mr-2 h-4 w-4 text-label-secondary" />
                                        {t("accounts.reconcile.open")}
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                }
                chevron
            >
                <Link to={`/accounts/${a.id}`} aria-label={label} />
            </ListRow>
        );
    };

    // Group header: label left, converted subtotal right.
    const renderGroupSubtotal = (group: AccountGroup) => {
        const needsPortfolioSummary = group.accounts.some((account) =>
            isPortfolioType(account.type),
        );
        if (needsPortfolioSummary && portfolioSummaryQuery.isLoading) {
            return (
                <p className="type-footnote text-label-secondary">
                    {t("accounts.group.subtotal")}{" "}
                    {t("accounts.group.subtotalPending")}
                </p>
            );
        }
        if (needsPortfolioSummary && portfolioSummaryQuery.isError) {
            return (
                <p className="type-footnote text-warning">
                    {t("accounts.group.subtotal")}{" "}
                    {t("accounts.group.subtotalUnavailable")}
                </p>
            );
        }
        const cash = sumConvertedBalances(
            group.accounts.filter(
                (account) => !isHoldingsOnlyPortfolioType(account.type),
            ),
            convertToTarget,
        );
        const holdings = group.accounts
            .filter((account) => isPortfolioType(account.type))
            .reduce(
                (sum, account) =>
                    sum +
                    (getBrokerAccountMetrics(portfolioSummary, account.id)
                        ?.holdingsValue ?? 0),
                0,
            );
        return (
            <p className="type-footnote text-label-secondary">
                {t("accounts.group.subtotal")}{" "}
                <span className="font-medium tabular-nums text-foreground">
                    <Money
                        amount={cash + holdings}
                        currency={displayCurrency}
                    />
                </span>
                {group.accounts.some(
                    (account) =>
                        !isHoldingsOnlyPortfolioType(account.type) &&
                        account.balance_incomplete,
                ) && (
                    <span className="ml-1 text-warning">
                        {t("accounts.group.subtotalIncomplete")}
                    </span>
                )}
            </p>
        );
    };

    const renderGroupList = (group: AccountGroup) => (
        <List>{group.accounts.map(renderAccountRow)}</List>
    );

    return (
        <PageShell className="">
            <PageHeader
                title={t("accounts.title")}
                subtitle={t("accounts.subtitle")}
                icon={PAGE_ICONS["/accounts"]}
                actions={<AddAccountDialog />}
            />

            {isLoading && (
                <div {...loadingSurfaceProps} className="space-y-3">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-[11.5rem] w-full rounded-card" />
                    <Skeleton className="h-5 w-28" />
                    <Skeleton className="h-[7.5rem] w-full rounded-card" />
                </div>
            )}

            {isError && (
                <PageError
                    message={apiErrorToMessage(error, t)}
                    onRetry={() => void refetch()}
                />
            )}

            {!isLoading && !isError && accounts.length === 0 && (
                <EmptyState
                    icon={PAGE_ICONS["/accounts"]}
                    title={t("accounts.emptyTitle")}
                    description={t("accounts.emptyDescription")}
                    action={<AddAccountDialog />}
                />
            )}

            {accounts.length > 0 && (
                <div className="space-y-6">
                    {visibleGroups.map((group) => (
                        <section
                            key={group.id}
                            aria-label={t(`accounts.group.${group.id}`)}
                            className="space-y-2"
                        >
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
                                <h2 className="type-headline text-foreground">
                                    {t(`accounts.group.${group.id}`)}
                                </h2>
                                {renderGroupSubtotal(group)}
                            </div>
                            {renderGroupList(group)}
                        </section>
                    ))}

                    {/* Grand line: Net cash = Cash & Savings + Liabilities over
                        in_net_worth accounts only — the same population WP-A1's
                        net-worth Liquid + Liabilities figures sum over. */}
                    <section aria-label={t("accounts.netCash")}>
                        <Card>
                            <CardContent
                                variant="headerless"
                                className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
                            >
                                <div className="min-w-0 max-w-prose">
                                    <h2 className="type-headline text-foreground">
                                        {t("accounts.netCash")}
                                    </h2>
                                    <p className="mt-0.5 type-footnote text-label-secondary">
                                        {t("accounts.netCashHint")}
                                    </p>
                                    {netCashIncomplete && (
                                        <p className="mt-1 type-footnote text-warning">
                                            {t("accounts.totalIncomplete")}
                                        </p>
                                    )}
                                </div>
                                <p className="type-title-1 tabular-nums text-foreground">
                                    <Money
                                        amount={netCash}
                                        currency={displayCurrency}
                                    />
                                </p>
                            </CardContent>
                        </Card>
                    </section>

                    {archivedGroup && (
                        <Collapsible
                            open={archivedOpen}
                            onOpenChange={setArchivedOpen}
                        >
                            <section
                                aria-label={t("accounts.group.archived")}
                                className="space-y-2"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
                                    <CollapsibleTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="-ml-2 gap-1.5 text-label-secondary hover:text-foreground"
                                        >
                                            <ChevronRight
                                                aria-hidden
                                                className={cn(
                                                    "h-4 w-4 transition-transform duration-fast ease-glide",
                                                    archivedOpen && "rotate-90",
                                                )}
                                            />
                                            {t("accounts.group.archived")}
                                            <span className="font-normal">
                                                ({archivedGroup.accounts.length}
                                                )
                                            </span>
                                        </Button>
                                    </CollapsibleTrigger>
                                    {renderGroupSubtotal(archivedGroup)}
                                </div>
                                <CollapsibleContent>
                                    {renderGroupList(archivedGroup)}
                                </CollapsibleContent>
                            </section>
                        </Collapsible>
                    )}
                </div>
            )}

            {reconciling && (
                <ReconcileDialog
                    key={reconciling.id}
                    account={reconciling}
                    open={!!reconciling}
                    onOpenChange={(o) => {
                        if (!o) setReconciling(undefined);
                    }}
                />
            )}
        </PageShell>
    );
}
