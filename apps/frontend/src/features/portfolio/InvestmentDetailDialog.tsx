import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/shared/Money";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/shared/EmptyState";
import {
    TrendingUp,
    TrendingDown,
    Eye,
    Trash2,
    Calendar,
    Banknote,
    Pencil,
    Plus,
    Archive,
    Receipt,
} from "lucide-react";
import { isUnitBased, isFixedIncome, isRealEstate } from "@/utils/assetClass";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { useFxAwarePnl } from "@/hooks/portfolio/useFxAwarePnl";
import { AddPortfolioTxnDialog } from "./AddPortfolioTxnDialog";
import { EditInvestmentDialog } from "./EditInvestmentDialog";
import { EditPortfolioTxnDialog } from "./EditPortfolioTxnDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import type { InvestmentSummary, PortfolioTxnType } from "@/types/portfolio";
import { getAssetClassLabel, getTxnTypeLabel } from "@/types/portfolio";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useControlledOpen } from "@/hooks/useDialogFormState";
import { TextLink } from "@/components/shared/TextLink";
import { PortfolioOversoldBadge } from "./PortfolioOversoldBadge";
import { FactRow } from "./assetPageParts";
import { toneClass } from "./useHoldingActions";

type TxnRow = InvestmentSummary["transactions"][number];

interface Props {
    investment: InvestmentSummary;
    trigger?: React.ReactNode;
    /**
     * Controlled mode: the caller owns the open state (e.g. a holdings row
     * menu opens the dialog), so no trigger is rendered.
     */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** When provided, replaces the embedded AddPortfolioTxnDialog with a callback */
    onAddTransaction?: (investment: InvestmentSummary) => void;
    /** When provided, replaces the embedded EditInvestmentDialog with a callback */
    onEditInvestment?: (investment: InvestmentSummary) => void;
    /** When provided, replaces the embedded EditPortfolioTxnDialog with a callback */
    onEditTransaction?: (txn: TxnRow, investment: InvestmentSummary) => void;
}

// Module-level plain-number formatter cache. The transactions tab calls fmtNum
// several times per row and re-renders the whole (unbounded) list on any
// dialog-level state change, so constructing a fresh Intl.NumberFormat per call
// (~50-200µs each) was pure waste. Currency formatting comes from the shared
// useCurrencyFormatter hook, which carries its own per-key cache (SIMP-67).
const numberFmtCache = new Map<string, Intl.NumberFormat>();
function getNumberFmt(locale: string, decimals: number): Intl.NumberFormat {
    const key = `${locale}:${decimals}`;
    let f = numberFmtCache.get(key);
    if (!f) {
        f = new Intl.NumberFormat(locale, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
        numberFmtCache.set(key, f);
    }
    return f;
}

const TXN_TYPE_COLORS: Record<PortfolioTxnType, string> = {
    buy: "border-accent/30 bg-accent/12 text-accent",
    sell: "border-destructive/30 bg-destructive/12 text-destructive",
    dividend: "border-primary/30 bg-primary/12 text-primary",
    interest: "border-primary/30 bg-primary/12 text-primary",
    rent_income: "border-accent/30 bg-accent/12 text-accent",
    gift: "border-primary/30 bg-primary/12 text-primary",
    fee: "border-border/60 bg-foreground/[0.06] text-label-secondary",
    tax: "border-border/60 bg-foreground/[0.06] text-label-secondary",
    appreciation: "border-accent/30 bg-accent/12 text-accent",
};

/** `space-y-2` between transaction rows, carried per row while virtualized. */
const TXN_ROW_GAP = 8;
/**
 * Seed height for a transaction row (p-3 + a type/date line + one detail line).
 * Only used until `measureElement` reports the row's real height, which it does
 * for every row the virtual window mounts.
 */
const TXN_ROW_ESTIMATE = 80;

type Translate = ReturnType<typeof useLanguage>["t"];

/**
 * One transaction row of the transactions tab. Extracted and memoized because
 * the list is unbounded: without this, every dialog-level state change (a
 * nested dialog opening, a price refetch replacing `investment`) re-ran the
 * render of every row — Badge, date formatting and several fmt/fmtNum calls
 * apiece. Props are value-stable per row, so a state change that doesn't touch
 * a row re-renders none of it.
 */
const TransactionRow = memo(function TransactionRow({
    txn,
    t,
    fmt,
    locale,
    dateFormat,
    nativeCurrency,
    nestedEdit,
    editDialogOpen,
    onEdit,
    onDelete,
    readOnly,
}: {
    txn: TxnRow;
    t: Translate;
    fmt: ReturnType<typeof useCurrencyFormatter>;
    locale: string;
    dateFormat: string;
    nativeCurrency: string;
    /** True when this dialog owns the edit dialog (no `onEditTransaction` prop). */
    nestedEdit: boolean;
    editDialogOpen: boolean;
    onEdit: (txn: TxnRow, event: React.MouseEvent<HTMLElement>) => void;
    onDelete: (txn: TxnRow) => void;
    readOnly: boolean;
}) {
    const fmtNum = (val: number, decimals = 2) =>
        getNumberFmt(locale, decimals).format(val);
    const transactionLabel = `${getTxnTypeLabel(t, txn.type as PortfolioTxnType)} · ${formatDateStringWithAppSettings(txn.date, dateFormat)}`;
    const editLabel = `${t("aria.editTransaction")}: ${transactionLabel}`;
    const deleteLabel = `${t("aria.deleteTransaction")}: ${transactionLabel}`;
    return (
        <div className="flex items-center gap-3 rounded-card corner-continuous bg-foreground/[0.04] p-3 transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.06]">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <Badge
                        variant="outline"
                        size="sm"
                        className={
                            TXN_TYPE_COLORS[txn.type as PortfolioTxnType]
                        }
                    >
                        {getTxnTypeLabel(t, txn.type as PortfolioTxnType)}
                    </Badge>
                    <span className="flex items-center gap-1 type-caption text-label-secondary">
                        <Calendar className="h-3 w-3" aria-hidden />
                        {formatDateStringWithAppSettings(txn.date, dateFormat)}
                    </span>
                </div>

                {txn.units != null && (
                    <p className="mt-1 type-caption tabular-nums text-label-secondary">
                        {t("invDetail.unitsAt", {
                            units: fmtNum(txn.units, 4),
                            price: fmt(
                                txn.price_per_unit ||
                                    (txn.units !== 0
                                        ? txn.amount / txn.units
                                        : 0),
                                {
                                    currency: txn.currency || nativeCurrency,
                                    decimals: 2,
                                },
                            ),
                        })}
                    </p>
                )}

                {txn.note && (
                    <p className="mt-1 truncate type-caption text-label-secondary">
                        {txn.note}
                    </p>
                )}
            </div>

            <div className="shrink-0 text-right">
                <p
                    className={cn(
                        "type-body font-medium tabular-nums",
                        ["buy", "fee", "tax"].includes(txn.type)
                            ? "text-loss"
                            : "text-gain",
                    )}
                >
                    <Money
                        amount={
                            ["buy", "fee", "tax"].includes(txn.type)
                                ? -Math.abs(txn.amount)
                                : Math.abs(txn.amount)
                        }
                        currency={txn.currency || nativeCurrency}
                        signed
                    />
                </p>

                {((txn.fees ?? 0) > 0 || (txn.taxes ?? 0) > 0) && (
                    <p className="type-caption tabular-nums text-label-secondary">
                        {(txn.fees ?? 0) > 0 &&
                            t("invDetail.fee", {
                                amount: fmt(txn.fees ?? 0, {
                                    currency: txn.currency || nativeCurrency,
                                }),
                            })}
                        {(txn.fees ?? 0) > 0 && (txn.taxes ?? 0) > 0 && " · "}
                        {(txn.taxes ?? 0) > 0 &&
                            t("invDetail.tax", {
                                amount: fmt(txn.taxes ?? 0, {
                                    currency: txn.currency || nativeCurrency,
                                }),
                            })}
                    </p>
                )}
            </div>

            {!readOnly && (
                <div className="flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            {!nestedEdit ? (
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="icon-touch-target shrink-0 text-label-secondary hover:text-foreground"
                                    onClick={(event) => onEdit(txn, event)}
                                    aria-label={editLabel}
                                >
                                    <Pencil className="h-4 w-4" />
                                </Button>
                            ) : (
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="icon-touch-target shrink-0 text-label-secondary hover:text-foreground"
                                    aria-label={editLabel}
                                    type="button"
                                    aria-haspopup="dialog"
                                    aria-expanded={editDialogOpen}
                                    onClick={(event) => onEdit(txn, event)}
                                >
                                    <Pencil className="h-4 w-4" />
                                </Button>
                            )}
                        </TooltipTrigger>
                        <TooltipContent>{editLabel}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                size="icon"
                                variant="ghost"
                                className="icon-touch-target shrink-0 text-label-secondary hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => onDelete(txn)}
                                aria-label={deleteLabel}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{deleteLabel}</TooltipContent>
                    </Tooltip>
                </div>
            )}
        </div>
    );
});

/**
 * Virtualized transactions list. The list is unbounded (a DCA'd dividend
 * holding accumulates hundreds of rows over the years) and every row used to be
 * mounted the moment the tab opened. Only the rows the 400px window can show
 * (plus overscan) are mounted now; the scroll container, row markup, row
 * spacing and hover behaviour are unchanged — rows stay in normal flow and the
 * skipped ones are represented by padding on the inner wrapper, so nothing is
 * absolutely positioned and no row can overlap its neighbour.
 */
function TransactionList({
    transactions,
    t,
    fmt,
    locale,
    dateFormat,
    nativeCurrency,
    nestedEdit,
    editTxnOpen,
    editTxnId,
    onEdit,
    onDelete,
    readOnly,
}: {
    transactions: TxnRow[];
    t: Translate;
    fmt: ReturnType<typeof useCurrencyFormatter>;
    locale: string;
    dateFormat: string;
    nativeCurrency: string;
    nestedEdit: boolean;
    editTxnOpen: boolean;
    editTxnId: number | null;
    onEdit: (txn: TxnRow, event: React.MouseEvent<HTMLElement>) => void;
    onDelete: (txn: TxnRow) => void;
    readOnly: boolean;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: transactions.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => TXN_ROW_ESTIMATE + TXN_ROW_GAP,
        overscan: 6,
    });
    const items = virtualizer.getVirtualItems();
    const paddingTop = items.length ? items[0]!.start : 0;
    const paddingBottom = items.length
        ? virtualizer.getTotalSize() - items[items.length - 1]!.end
        : 0;

    return (
        <div ref={scrollRef} className="max-h-[400px] overflow-y-auto pr-2">
            {/* Reserve the full extent before the first viewport measurement.
                Otherwise an empty virtual window collapses this max-height
                scroller to zero and no transaction can ever mount. */}
            <div
                style={{
                    minHeight: virtualizer.getTotalSize(),
                    paddingTop,
                    paddingBottom,
                }}
            >
                {items.map((item) => {
                    const txn = transactions[item.index];
                    if (!txn) return null;
                    return (
                        <div
                            key={txn.id}
                            data-index={item.index}
                            ref={virtualizer.measureElement}
                            // The gap `space-y-2` used to draw, carried by the row itself so
                            // the virtualizer measures it as part of the row's extent.
                            style={{
                                paddingBottom:
                                    item.index === transactions.length - 1
                                        ? undefined
                                        : TXN_ROW_GAP,
                            }}
                        >
                            <TransactionRow
                                txn={txn}
                                t={t}
                                fmt={fmt}
                                locale={locale}
                                dateFormat={dateFormat}
                                nativeCurrency={nativeCurrency}
                                nestedEdit={nestedEdit}
                                editDialogOpen={
                                    editTxnOpen && editTxnId === txn.id
                                }
                                onEdit={onEdit}
                                onDelete={onDelete}
                                readOnly={readOnly}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function InvestmentDetailDialog({
    investment,
    trigger,
    open: openProp,
    onOpenChange,
    onAddTransaction,
    onEditInvestment,
    onEditTransaction,
}: Props) {
    const { open, setOpen, controlled } = useControlledOpen({
        open: openProp,
        onOpenChange,
    });

    // The three nested dialogs are mounted OUTSIDE this dialog's DialogContent.
    // Radix unmounts content when the dialog closes, so a nested dialog rendered
    // inside it lost its preserved draft (useDialogFormState only survives while
    // mounted) the moment this outer dialog was dismissed — the user's own
    // dialog was never the one being dismissed, which made the loss silent.
    // Mounting is therefore this component's, not the content's; opening is
    // driven by the controls below. `nestedMounted` keeps the cost off rows the
    // user never opened (usePortfolio recomputes the whole portfolio per
    // consumer, and there is one of these per holding row).
    const [nestedMounted, setNestedMounted] = useState(false);
    // In controlled mode Radix never reports the opening through
    // onOpenChange, so the nested dialogs are mounted from the prop instead.
    useEffect(() => {
        if (open) setNestedMounted(true);
    }, [open]);
    const [addTxnOpen, setAddTxnOpen] = useState(false);
    const [editInvestmentOpen, setEditInvestmentOpen] = useState(false);
    // The row being edited is held by id, so the dialog keeps reading the live
    // transaction after a refetch instead of a frozen copy. It is deliberately
    // NOT cleared on close: that is what keeps the draft alive for a reopen.
    const [editTxnId, setEditTxnId] = useState<number | null>(null);
    const [editTxnOpen, setEditTxnOpen] = useState(false);
    const editTxn = investment.transactions.find((tx) => tx.id === editTxnId);
    // Without a DialogTrigger of their own the nested dialogs have nothing to
    // hand focus back to, so the control that opened them is remembered here.
    const nestedOpenerRef = useRef<HTMLElement | null>(null);

    const openNested =
        (openDialog: (v: boolean) => void) =>
        (event: React.MouseEvent<HTMLElement>) => {
            nestedOpenerRef.current = event.currentTarget;
            openDialog(true);
        };

    const { deleteTransaction, updateInvestment, isUpdatingInvestment } =
        usePortfolio();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const sectionId = useId();
    const formatPercent = usePercentFormatter();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    // Shared cached currency formatter: fmt(val, currency?, decimals?) with the
    // same defaults (app default currency, showDecimalPlaces) as the old local copy.
    const fmt = useCurrencyFormatter();

    function fmtNum(val: number, decimals = 2) {
        return getNumberFmt(locale, decimals).format(val);
    }

    const unitBased = isUnitBased(investment.assetClass);
    const fixedIncome = isFixedIncome(investment.assetClass);
    const realEstate = isRealEstate(investment.assetClass);
    const archived = investment.is_active === false;

    // Anything FX-related is shown only when the holding is in a foreign currency;
    // for base-currency holdings the conversion is a no-op and the extra rows
    // would just duplicate the native figures. On an InvestmentSummary `currency`
    // is the display/target currency (all amounts are converted to it) — the
    // holding's NATIVE currency lives in `originalCurrency`, which is what decides
    // foreign-ness.
    const targetCurrency = appSettings.defaultCurrency || "EUR";
    const nativeCurrency = (
        investment.originalCurrency ||
        investment.currency ||
        "EUR"
    ).toUpperCase();
    const isForeignCurrency = nativeCurrency !== targetCurrency.toUpperCase();

    // FX attribution from the backend summary (it owns the historical-rate
    // machinery). The query is shared with the overview/performance pages, so this
    // is usually a cache hit.
    const { data: apiSummary } = usePortfolioSummaryQuery(targetCurrency);
    const apiHolding = apiSummary?.summaries.find(
        (summary) => summary.id === investment.id,
    );
    const fxSummary = isForeignCurrency ? apiHolding : undefined;

    // FX-aware realized/unrealized P&L in the target currency, computed here so the
    // dialog renders identically wherever it is opened (overview, stocks, crypto,
    // …) instead of depending on the caller to pass it in.
    const computeFxAwarePnl = useFxAwarePnl(targetCurrency);
    const fxAwarePnl = isForeignCurrency
        ? computeFxAwarePnl(investment)
        : undefined;

    // The same add-transaction control appears in three spots (overview footer,
    // empty-transactions CTA, transactions footer) — build it once.
    const addTransactionControl = archived ? null : onAddTransaction ? (
        <Button size="sm" onClick={() => onAddTransaction(investment)}>
            <Plus />
            {t("portfolio.addTransaction")}
        </Button>
    ) : (
        // Same button AddPortfolioTxnDialog renders as its own default trigger; it
        // only opens the lifted dialog below instead of being that dialog's trigger,
        // so it also carries by hand the opener semantics DialogTrigger used to add.
        <Button
            size="sm"
            variant="outline"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={addTxnOpen}
            onClick={openNested(setAddTxnOpen)}
        >
            <Plus />
            {t("form.addTransaction.title")}
        </Button>
    );

    // The two row callbacks are props of the memoized transaction rows, so they
    // are kept identity-stable: `investment` and `onEditTransaction` are read
    // through refs rather than closed over, because a price refetch replaces the
    // `investment` object and would otherwise re-render every row.
    const investmentRef = useRef(investment);
    investmentRef.current = investment;
    const onEditTransactionRef = useRef(onEditTransaction);
    onEditTransactionRef.current = onEditTransaction;

    const handleEditTxn = useCallback(
        (txn: TxnRow, event: React.MouseEvent<HTMLElement>) => {
            const external = onEditTransactionRef.current;
            if (external) {
                external(txn, investmentRef.current);
                return;
            }
            nestedOpenerRef.current = event.currentTarget;
            setEditTxnId(txn.id);
            setEditTxnOpen(true);
        },
        [],
    );

    const handleDeleteTxn = useCallback(
        async (txn: TxnRow) => {
            const ok = await confirm({
                title: t("invDetail.delete.title"),
                description: t("invDetail.delete.desc", {
                    txType: getTxnTypeLabel(t, txn.type as PortfolioTxnType),
                }),
                confirmLabel: t("invDetail.delete.confirm"),
                variant: "destructive",
            });
            if (ok) deleteTransaction(txn.id);
        },
        [confirm, deleteTransaction, t],
    );

    const handleArchive = useCallback(async () => {
        const ok = await confirm({
            title: t("portfolio.archiveInvestment"),
            description: t("portfolio.archiveInvestmentDesc", {
                name: investment.name,
            }),
            confirmLabel: t("portfolio.archiveInvestment"),
        });
        if (!ok) return;
        await updateInvestment(investment.id, { is_active: false });
        setOpen(false);
    }, [confirm, investment.id, investment.name, t, updateInvestment, setOpen]);

    const researchHref = investment.symbol
        ? `/research/market?symbol=${encodeURIComponent(investment.symbol)}&investmentId=${investment.id}`
        : undefined;
    const hasRealEstateFacts =
        realEstate &&
        (investment.municipality ||
            investment.cadastral_income != null ||
            investment.municipality_tax_rate != null);

    return (
        <>
            <Dialog
                open={open}
                onOpenChange={(v) => {
                    if (v) setNestedMounted(true);
                    setOpen(v);
                }}
            >
                {!controlled && (
                    <DialogTrigger asChild>
                        {trigger ?? (
                            <Button size="sm" variant="ghost">
                                <Eye />
                                {t("invDetail.trigger")}
                            </Button>
                        )}
                    </DialogTrigger>
                )}
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader className="space-y-3 pr-6">
                        <div className="flex flex-wrap items-center gap-2">
                            {investment.symbol && (
                                <span className="font-mono type-headline text-primary">
                                    {investment.symbol}
                                </span>
                            )}
                            <DialogTitle className="min-w-0 truncate">
                                {researchHref ? (
                                    <TextLink to={researchHref}>
                                        {investment.name}
                                    </TextLink>
                                ) : (
                                    investment.name
                                )}
                            </DialogTitle>
                            <Badge variant="secondary" size="sm">
                                {getAssetClassLabel(t, investment.assetClass)}
                            </Badge>
                            {archived && (
                                <Badge variant="outline" size="sm">
                                    {t("portfolio.archived")}
                                </Badge>
                            )}
                            <PortfolioOversoldBadge
                                oversold={
                                    apiHolding?.oversold ?? investment.oversold
                                }
                            />
                        </div>
                        <DialogDescription className="sr-only">
                            {investment.name}
                        </DialogDescription>
                        {!archived && (
                            <div className="flex flex-wrap items-center gap-2">
                                {onEditInvestment ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        aria-label={`${t("common.edit")}: ${investment.name}`}
                                        onClick={() =>
                                            onEditInvestment(investment)
                                        }
                                    >
                                        <Pencil />
                                        {t("common.edit")}
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        aria-label={`${t("common.edit")}: ${investment.name}`}
                                        type="button"
                                        aria-haspopup="dialog"
                                        aria-expanded={editInvestmentOpen}
                                        onClick={openNested(
                                            setEditInvestmentOpen,
                                        )}
                                    >
                                        <Pencil />
                                        {t("common.edit")}
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="outline"
                                    aria-label={`${t("portfolio.archiveInvestment")}: ${investment.name}`}
                                    disabled={isUpdatingInvestment}
                                    onClick={() => void handleArchive()}
                                >
                                    <Archive />
                                    {t("portfolio.archiveInvestment")}
                                </Button>
                            </div>
                        )}
                    </DialogHeader>

                    {archived && (
                        <Alert>
                            <AlertDescription>
                                {t("portfolio.archivedExcluded")}
                            </AlertDescription>
                        </Alert>
                    )}

                    <Tabs defaultValue="overview" className="mt-2">
                        <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="overview">
                                {t("invDetail.tab.performance")}
                            </TabsTrigger>
                            <TabsTrigger value="transactions">
                                {t("invDetail.tab.transactions", {
                                    n: investment.transactions.length,
                                })}
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent
                            value="overview"
                            className="mt-4 space-y-6"
                        >
                            <div className="grid grid-cols-2 gap-4">
                                <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 type-caption text-label-tertiary">
                                        <Banknote
                                            className="h-3.5 w-3.5"
                                            aria-hidden
                                        />
                                        {t("invDetail.currentValue")}
                                    </p>
                                    <p className="truncate type-title-1 tabular-nums">
                                        <Money
                                            amount={investment.currentValue}
                                            currency={investment.currency}
                                        />
                                    </p>
                                </div>
                                <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 type-caption text-label-tertiary">
                                        {investment.totalGain >= 0 ? (
                                            <TrendingUp
                                                className="h-3.5 w-3.5 text-gain"
                                                aria-hidden
                                            />
                                        ) : (
                                            <TrendingDown
                                                className="h-3.5 w-3.5 text-loss"
                                                aria-hidden
                                            />
                                        )}
                                        {t("invDetail.totalGainLoss")}
                                    </p>
                                    <p
                                        className={cn(
                                            "truncate type-title-1 tabular-nums",
                                            toneClass(investment.totalGain),
                                        )}
                                    >
                                        <Money
                                            amount={investment.totalGain}
                                            currency={investment.currency}
                                            signed
                                        />
                                    </p>
                                    <p
                                        className={cn(
                                            "type-footnote tabular-nums",
                                            toneClass(
                                                investment.gainLossPercent,
                                            ),
                                        )}
                                    >
                                        {formatPercent(
                                            investment.gainLossPercent,
                                            { digits: 2, signed: true },
                                        )}
                                    </p>
                                </div>
                            </div>

                            <section aria-labelledby={`${sectionId}-breakdown`}>
                                <h3
                                    id={`${sectionId}-breakdown`}
                                    className="eyebrow mb-1"
                                >
                                    {t("invDetail.breakdown")}
                                </h3>
                                <dl className="divide-y divide-border/50">
                                    <FactRow
                                        label={t("invDetail.totalCost")}
                                        value={fmt(investment.totalBuyCost, {
                                            currency: investment.currency,
                                        })}
                                    />
                                    {unitBased && (
                                        <>
                                            <FactRow
                                                label={t("invDetail.unitsHeld")}
                                                value={fmtNum(
                                                    investment.totalUnits,
                                                    4,
                                                )}
                                            />
                                            <FactRow
                                                label={t(
                                                    "invDetail.avgCostPerUnit",
                                                )}
                                                value={fmt(
                                                    investment.avgCostBasis,
                                                    {
                                                        currency:
                                                            investment.currency,
                                                        decimals: 2,
                                                    },
                                                )}
                                            />
                                            {investment.currentPrice ? (
                                                <FactRow
                                                    label={t(
                                                        "invDetail.currentPrice",
                                                    )}
                                                    value={fmt(
                                                        investment.currentPrice,
                                                        {
                                                            currency:
                                                                investment.currency,
                                                            decimals: 2,
                                                        },
                                                    )}
                                                />
                                            ) : null}
                                        </>
                                    )}
                                    {fixedIncome && investment.interestRate ? (
                                        <FactRow
                                            label={t("invDetail.interestRate")}
                                            value={`${fmtNum(investment.interestRate)}%`}
                                        />
                                    ) : null}
                                    {hasRealEstateFacts && (
                                        <>
                                            {investment.municipality && (
                                                <FactRow
                                                    label={t(
                                                        "invDetail.municipality",
                                                    )}
                                                    value={
                                                        investment.municipality
                                                    }
                                                />
                                            )}
                                            {investment.cadastral_income !=
                                                null && (
                                                <FactRow
                                                    label={t(
                                                        "invDetail.cadastralIncome",
                                                    )}
                                                    value={fmt(
                                                        investment.cadastral_income,
                                                        {
                                                            currency:
                                                                investment.currency,
                                                        },
                                                    )}
                                                />
                                            )}
                                            {investment.municipality_tax_rate !=
                                                null && (
                                                <FactRow
                                                    label={t(
                                                        "invDetail.municipalityTaxRate",
                                                    )}
                                                    value={`${fmtNum(investment.municipality_tax_rate)}%`}
                                                />
                                            )}
                                        </>
                                    )}
                                    <FactRow
                                        label={t("invDetail.realizedGain")}
                                        tone={toneClass(
                                            investment.realizedGain,
                                        )}
                                        value={
                                            <Money
                                                amount={investment.realizedGain}
                                                currency={investment.currency}
                                                signed
                                            />
                                        }
                                        detail={
                                            fxAwarePnl ? (
                                                <>
                                                    {t(
                                                        "invDetail.fxAwareRealized",
                                                        {
                                                            currency:
                                                                targetCurrency,
                                                        },
                                                    )}
                                                    {": "}
                                                    <Money
                                                        amount={
                                                            fxAwarePnl.realizedTarget
                                                        }
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed
                                                    />
                                                </>
                                            ) : undefined
                                        }
                                    />
                                    <FactRow
                                        label={t("invDetail.unrealizedGain")}
                                        tone={toneClass(
                                            investment.unrealizedGain,
                                        )}
                                        value={
                                            <Money
                                                amount={
                                                    investment.unrealizedGain
                                                }
                                                currency={investment.currency}
                                                signed
                                            />
                                        }
                                        detail={
                                            fxAwarePnl ? (
                                                <>
                                                    {t(
                                                        "invDetail.fxAwareUnrealized",
                                                        {
                                                            currency:
                                                                targetCurrency,
                                                        },
                                                    )}
                                                    {": "}
                                                    <Money
                                                        amount={
                                                            fxAwarePnl.unrealizedTarget
                                                        }
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed
                                                    />{" "}
                                                    (
                                                    {formatPercent(
                                                        fxAwarePnl.unrealizedPercent,
                                                        {
                                                            digits: 2,
                                                            signed: true,
                                                        },
                                                    )}
                                                    )
                                                </>
                                            ) : undefined
                                        }
                                    />
                                    {investment.totalIncome > 0 && (
                                        <FactRow
                                            label={t("invDetail.totalIncome")}
                                            tone="text-gain"
                                            value={
                                                <Money
                                                    amount={
                                                        investment.totalIncome
                                                    }
                                                    currency={
                                                        investment.currency
                                                    }
                                                    signed
                                                />
                                            }
                                        />
                                    )}
                                    {(investment.totalFees > 0 ||
                                        investment.totalTaxes > 0) && (
                                        <FactRow
                                            label={t("invDetail.feesAndTaxes")}
                                            tone="text-loss"
                                            value={
                                                <Money
                                                    amount={
                                                        -(
                                                            investment.totalFees +
                                                            investment.totalTaxes
                                                        )
                                                    }
                                                    currency={
                                                        investment.currency
                                                    }
                                                    signed
                                                />
                                            }
                                        />
                                    )}
                                </dl>
                            </section>

                            {fxSummary &&
                                typeof fxSummary.fxGain === "number" && (
                                    <section
                                        aria-labelledby={`${sectionId}-fx`}
                                    >
                                        <h3
                                            id={`${sectionId}-fx`}
                                            className="eyebrow mb-1"
                                        >
                                            {t("invDetail.fxAttribution")}
                                        </h3>
                                        <dl className="divide-y divide-border/50">
                                            <FactRow
                                                label={t(
                                                    "portfolio.nativeValue",
                                                    {
                                                        currency:
                                                            nativeCurrency,
                                                    },
                                                )}
                                                value={fmt(
                                                    fxSummary.nativeCurrentValue ??
                                                        investment.currentValue,
                                                    {
                                                        currency:
                                                            nativeCurrency,
                                                    },
                                                )}
                                            />
                                            <FactRow
                                                label={t(
                                                    "invDetail.investedAtHistoricalRates",
                                                    {
                                                        currency:
                                                            targetCurrency,
                                                    },
                                                )}
                                                value={fmt(
                                                    fxSummary.totalInvested,
                                                    {
                                                        currency:
                                                            targetCurrency,
                                                    },
                                                )}
                                            />
                                            <FactRow
                                                label={t("portfolio.assetGain")}
                                                tone={toneClass(
                                                    fxSummary.assetGain ?? 0,
                                                )}
                                                value={
                                                    <Money
                                                        amount={
                                                            fxSummary.assetGain ??
                                                            0
                                                        }
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed
                                                    />
                                                }
                                            />
                                            <FactRow
                                                label={t("portfolio.fxEffect")}
                                                tone={toneClass(
                                                    fxSummary.fxGain,
                                                )}
                                                value={
                                                    <Money
                                                        amount={
                                                            fxSummary.fxGain
                                                        }
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed
                                                    />
                                                }
                                            />
                                        </dl>
                                        {fxSummary.usedFallbackRate && (
                                            <p className="mt-2 type-caption text-warning">
                                                {t("portfolio.fxFallbackNote")}
                                            </p>
                                        )}
                                    </section>
                                )}

                            {fixedIncome &&
                                investment.projectedAnnualInterest > 0 && (
                                    <section
                                        aria-labelledby={`${sectionId}-income`}
                                    >
                                        <h3
                                            id={`${sectionId}-income`}
                                            className="eyebrow mb-1"
                                        >
                                            {t(
                                                "portfolio.projectedAnnualInterest",
                                            )}
                                        </h3>
                                        <dl className="divide-y divide-border/50">
                                            <FactRow
                                                label={t(
                                                    "portfolio.projectedAnnualInterest",
                                                )}
                                                tone="text-primary"
                                                value={
                                                    <Money
                                                        amount={
                                                            investment.projectedAnnualInterest
                                                        }
                                                        currency={
                                                            investment.currency
                                                        }
                                                        signed
                                                    />
                                                }
                                            />
                                            {investment.accruedInterest > 0 && (
                                                <FactRow
                                                    label={t(
                                                        "portfolio.accruedUnpaid",
                                                    )}
                                                    tone="text-gain"
                                                    value={
                                                        <Money
                                                            amount={
                                                                investment.accruedInterest
                                                            }
                                                            currency={
                                                                investment.currency
                                                            }
                                                            signed
                                                        />
                                                    }
                                                />
                                            )}
                                        </dl>
                                    </section>
                                )}

                            {realEstate &&
                                investment.totalAppreciation !== 0 && (
                                    <section
                                        aria-labelledby={`${sectionId}-property`}
                                    >
                                        <h3
                                            id={`${sectionId}-property`}
                                            className="eyebrow mb-1"
                                        >
                                            {t("invDetail.totalAppreciation")}
                                        </h3>
                                        <dl className="divide-y divide-border/50">
                                            <FactRow
                                                label={t(
                                                    "invDetail.totalAppreciation",
                                                )}
                                                tone={toneClass(
                                                    investment.totalAppreciation,
                                                )}
                                                value={
                                                    <Money
                                                        amount={
                                                            investment.totalAppreciation
                                                        }
                                                        currency={
                                                            investment.currency
                                                        }
                                                        signed
                                                    />
                                                }
                                            />
                                            {investment.totalIncome > 0 && (
                                                <FactRow
                                                    label={t(
                                                        "portfolio.rentalIncome",
                                                    )}
                                                    tone="text-gain"
                                                    value={
                                                        <Money
                                                            amount={
                                                                investment.totalIncome
                                                            }
                                                            currency={
                                                                investment.currency
                                                            }
                                                            signed
                                                        />
                                                    }
                                                />
                                            )}
                                        </dl>
                                    </section>
                                )}

                            {addTransactionControl && (
                                <div className="flex justify-end">
                                    {addTransactionControl}
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="transactions" className="mt-4">
                            {investment.transactions.length === 0 ? (
                                <EmptyState
                                    icon={Receipt}
                                    size="compact"
                                    headingLevel={3}
                                    title={t("invDetail.noTransactions")}
                                    action={addTransactionControl ?? undefined}
                                />
                            ) : (
                                <TransactionList
                                    transactions={investment.transactions}
                                    t={t}
                                    fmt={fmt}
                                    locale={locale}
                                    dateFormat={appSettings.dateFormat}
                                    nativeCurrency={nativeCurrency}
                                    nestedEdit={!onEditTransaction}
                                    editTxnOpen={editTxnOpen}
                                    editTxnId={editTxnId}
                                    onEdit={handleEditTxn}
                                    onDelete={handleDeleteTxn}
                                    readOnly={archived}
                                />
                            )}

                            {investment.transactions.length > 0 &&
                                addTransactionControl && (
                                    <div className="mt-4 flex justify-end border-t border-border/50 pt-4">
                                        {addTransactionControl}
                                    </div>
                                )}
                        </TabsContent>
                    </Tabs>
                </DialogContent>
            </Dialog>
            {/* Siblings of the dialog above, not children of its content: they must
          outlive its dismissal for their drafts to survive one. */}
            {nestedMounted && !archived && !onAddTransaction && (
                <AddPortfolioTxnDialog
                    investment={investment}
                    open={addTxnOpen}
                    onOpenChange={setAddTxnOpen}
                    returnFocusRef={nestedOpenerRef}
                />
            )}
            {nestedMounted && !archived && !onEditInvestment && (
                <EditInvestmentDialog
                    investment={investment}
                    open={editInvestmentOpen}
                    onOpenChange={setEditInvestmentOpen}
                    returnFocusRef={nestedOpenerRef}
                />
            )}
            {nestedMounted && !archived && !onEditTransaction && editTxn && (
                <EditPortfolioTxnDialog
                    investment={investment}
                    transaction={editTxn}
                    open={editTxnOpen}
                    onOpenChange={setEditTxnOpen}
                    returnFocusRef={nestedOpenerRef}
                />
            )}
            <ConfirmDialog />
        </>
    );
}
