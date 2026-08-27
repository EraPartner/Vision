import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { EmptyState } from "@/components/shared/EmptyState";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    MoreVertical,
    Receipt,
    Scale,
    ChevronRight,
    PanelRight,
} from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBalanceProvenance } from "@/features/accounts/balanceProvenance";
import { useDriftBadge } from "@/features/accounts/driftBadge";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    groupAccounts,
    sumConvertedBalances,
    computeNetCash,
    isPortfolioType,
    type AccountGroup,
} from "@/features/accounts/groupAccounts";
import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { ReconcileDialog } from "@/features/accounts/ReconcileDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import type { Account } from "@/types/api";
import { Money } from "@/components/shared/Money";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";

export default function AccountsPage() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
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

    // Legacy deep link (?account=<id>) from before the /accounts/:id route:
    // forward to the route (replace, so Back doesn't bounce through the hub).
    // One concept, one detail code path (Accounts-rewrite Phase D → WP-B4).
    const detailParam = searchParams.get("account");
    useEffect(() => {
        if (!detailParam) return;
        navigate(`/accounts/${detailParam}`, { replace: true });
    }, [detailParam, navigate]);

    // Filter by the account entity's id (ADR-088) — reads key on the FK, not
    // the retiring bank_account string.
    const accountTransactionsHref = (a: Account) => {
        const params = new URLSearchParams({
            account_id: String(a.id),
            filter_label: a.display_name || a.name,
        });
        return `/transactions?${params.toString()}`;
    };

    const renderAccountCard = (a: Account) => {
        // Portfolio accounts (brokerage/crypto/pension) keep their activity in
        // portfolio_transactions, not the ledger — only offer "view transactions"
        // when there actually are ledger rows to show.
        const canViewTransactions = a.has_transactions !== false;
        // Provenance subline (WP-B2): where the computed balance comes
        // from — stamped statement anchor + entries since, or plain sum.
        const provenanceText = balanceProvenance(a);
        // Portfolio-type cards have no real cash value until WP-C5's holdings
        // land — a "€0,00" computed ledger balance is misleading, so show a
        // placeholder instead (§3 F8).
        const portfolioPlaceholder = isPortfolioType(a.type);
        // Drift chip content: "Drift +€15,50 · statement 03/06/2026", in warning
        // tone once that statement reading is older than ~45 days (§3 F1).
        const drift = driftBadge(a);
        return (
            <Card
                key={a.id}
                className={cn(
                    "transition-shadow hover:shadow-glass-soft",
                    !a.is_active && "opacity-60",
                )}
            >
                <CardContent
                    variant="compact"
                    className="flex items-start justify-between gap-3"
                >
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <TextLink
                                to={`/accounts/${a.id}`}
                                className="truncate font-semibold tracking-tight"
                            >
                                {a.display_name || a.name}
                            </TextLink>
                            {!a.is_active && (
                                <Badge variant="outline" className="text-xs">
                                    {t("accounts.archived")}
                                </Badge>
                            )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge variant="secondary" className="text-xs">
                                {t(`accounts.type.${a.type}`)}
                            </Badge>
                            {!a.in_net_worth && (
                                <Badge
                                    variant="outline"
                                    className="text-xs font-normal text-muted-foreground"
                                >
                                    {t("accounts.notInNetWorth")}
                                </Badge>
                            )}
                            <span>{a.currency}</span>
                            {a.institution && <span>· {a.institution}</span>}
                            {drift && (
                                // Clicking the drift badge opens the reconcile dialog
                                // (statement vs computed + delta → accept / adjust).
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            // Kept as a template literal: badgeVariants sets text-2xs and the
                                            // appended text-xs deliberately overrides it; cn()'s tailwind-merge
                                            // would resolve the font-size differently, so preserve the raw join.
                                            className={`${badgeVariants({ variant: drift.variant })} cursor-pointer text-xs`}
                                            aria-label={t(
                                                "accounts.reconcile.open",
                                            )}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setReconciling(a);
                                            }}
                                        >
                                            {drift.label}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {drift.tooltip}
                                    </TooltipContent>
                                </Tooltip>
                            )}
                        </div>
                        {portfolioPlaceholder ? (
                            <div className="mt-2 text-sm font-medium text-muted-foreground">
                                {t("accounts.trackedInPortfolio")}
                            </div>
                        ) : (
                            <>
                                {a.computed_balance != null && (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <div className="mt-2 text-lg font-semibold tabular-nums">
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
                                )}
                                {a.computed_balance != null &&
                                    provenanceText && (
                                        <div className="mt-0.5 text-xs text-muted-foreground">
                                            {provenanceText}
                                        </div>
                                    )}
                            </>
                        )}
                    </div>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                aria-label={t("accounts.actionsMenu")}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <MoreVertical className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        {/* WP-B4: the hub card keeps explicit open + reconcile controls; Edit / Merge /
                        Close (+ opening balance, archive, delete) live in the
                        /accounts/:id header menu now. The menu stays as the
                        keyboard/touch-accessible secondary route to the detail page. */}
                        <DropdownMenuContent
                            align="end"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <DropdownMenuItem asChild>
                                <Link to={`/accounts/${a.id}`}>
                                    <PanelRight className="mr-2 h-4 w-4" />{" "}
                                    {t("accounts.viewDetails")}
                                </Link>
                            </DropdownMenuItem>
                            {canViewTransactions && (
                                <DropdownMenuItem asChild>
                                    <Link to={accountTransactionsHref(a)}>
                                        <Receipt className="mr-2 h-4 w-4" />{" "}
                                        {t("accounts.openTransactions")}
                                    </Link>
                                </DropdownMenuItem>
                            )}
                            {drift && (
                                <DropdownMenuItem
                                    onClick={() => setReconciling(a)}
                                >
                                    <Scale className="mr-2 h-4 w-4" />{" "}
                                    {t("accounts.reconcile.open")}
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </CardContent>
            </Card>
        );
    };

    // Group header: label left, converted subtotal right — mirrors the muted
    // section-header idiom used elsewhere; cards themselves are untouched.
    const renderGroupSubtotal = (group: AccountGroup) => (
        <p className="text-xs text-muted-foreground">
            {t("accounts.group.subtotal")}{" "}
            <span className="font-semibold tabular-nums text-foreground">
                <Money
                    amount={sumConvertedBalances(
                        group.accounts,
                        convertToTarget,
                    )}
                    currency={displayCurrency}
                />
            </span>
        </p>
    );

    return (
        <PageShell className="">
            <PageHeader
                title={t("accounts.title")}
                subtitle={t("accounts.subtitle")}
                icon={PAGE_ICONS["/accounts"]}
                actions={<AddAccountDialog />}
            />

            {isLoading && <SectionLoader />}

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
                            className="space-y-3"
                        >
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <h2 className="text-sm font-semibold tracking-tight">
                                    {t(`accounts.group.${group.id}`)}
                                </h2>
                                {renderGroupSubtotal(group)}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {group.accounts.map(renderAccountCard)}
                            </div>
                        </section>
                    ))}

                    {/* Grand line: Net cash = Cash & Savings + Liabilities over
                        in_net_worth accounts only — the same population WP-A1's
                        net-worth Liquid + Liabilities figures sum over. */}
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border/60 pt-4">
                        <div>
                            <h2 className="text-sm font-semibold tracking-tight">
                                {t("accounts.netCash")}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                {t("accounts.netCashHint")}
                            </p>
                        </div>
                        <span className="text-lg font-semibold tabular-nums">
                            <Money
                                amount={netCash}
                                currency={displayCurrency}
                            />
                        </span>
                    </div>

                    {archivedGroup && (
                        <Collapsible
                            open={archivedOpen}
                            onOpenChange={setArchivedOpen}
                        >
                            <section
                                aria-label={t("accounts.group.archived")}
                                className="space-y-3"
                            >
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                    <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted-foreground transition-colors hover:text-foreground">
                                        <ChevronRight
                                            className={cn(
                                                "h-4 w-4 transition-transform",
                                                archivedOpen && "rotate-90",
                                            )}
                                        />
                                        {t("accounts.group.archived")}
                                        <span className="font-normal">
                                            ({archivedGroup.accounts.length})
                                        </span>
                                    </CollapsibleTrigger>
                                    {renderGroupSubtotal(archivedGroup)}
                                </div>
                                <CollapsibleContent>
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                        {archivedGroup.accounts.map(
                                            renderAccountCard,
                                        )}
                                    </div>
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
