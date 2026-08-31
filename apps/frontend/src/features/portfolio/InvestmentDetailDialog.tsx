import { memo, useCallback, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/shared/Money";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    TrendingUp,
    TrendingDown,
    Eye,
    Trash2,
    Calendar,
    Banknote,
    Percent,
    ArrowUpRight,
    Clock,
    Pencil,
    Plus,
} from "lucide-react";
import { isUnitBased, isFixedIncome, isRealEstate } from "@/utils/assetClass";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { useFxAwarePnl } from "@/hooks/portfolio/useFxAwarePnl";
import { AddPortfolioTxnDialog } from "./AddPortfolioTxnDialog";
import { EditInvestmentDialog } from "./EditInvestmentDialog";
import { EditPortfolioTxnDialog } from "./EditPortfolioTxnDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import type { InvestmentSummary, PortfolioTxnType } from "@/types/portfolio";
import { getAssetClassLabel, getTxnTypeLabel } from "@/types/portfolio";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { TextLink } from "@/components/shared/TextLink";

type TxnRow = InvestmentSummary["transactions"][number];

interface Props {
    investment: InvestmentSummary;
    trigger?: React.ReactNode;
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
    buy: "bg-accent/10 text-accent border-accent/20",
    sell: "bg-destructive/10 text-destructive border-destructive/20",
    dividend: "bg-primary/10 text-primary border-primary/20",
    interest: "bg-primary/10 text-primary border-primary/20",
    rent_income: "bg-accent/10 text-accent border-accent/20",
    gift: "bg-primary/10 text-primary border-primary/20",
    fee: "bg-muted text-muted-foreground border-border",
    tax: "bg-muted text-muted-foreground border-border",
    appreciation: "bg-accent/10 text-accent border-accent/20",
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
}) {
    const fmtNum = (val: number, decimals = 2) =>
        getNumberFmt(locale, decimals).format(val);
    return (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <Badge
                        variant="outline"
                        className={cn(
                            "text-xs",
                            TXN_TYPE_COLORS[txn.type as PortfolioTxnType],
                        )}
                    >
                        {getTxnTypeLabel(t, txn.type as PortfolioTxnType)}
                    </Badge>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDateStringWithAppSettings(txn.date, dateFormat)}
                    </span>
                </div>

                {txn.units != null && (
                    <p className="text-xs text-muted-foreground mt-1">
                        {t("invDetail.unitsAt", {
                            units: fmtNum(txn.units, 4),
                            price: fmt(
                                txn.price_per_unit ||
                                    (txn.units !== 0
                                        ? txn.amount / txn.units
                                        : 0),
                                txn.currency || nativeCurrency,
                                2,
                            ),
                        })}
                    </p>
                )}

                {txn.note && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                        {txn.note}
                    </p>
                )}
            </div>

            <div className="text-right shrink-0">
                <p
                    className={cn(
                        "font-bold tabular-nums",
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
                    <p className="text-xs text-muted-foreground">
                        {(txn.fees ?? 0) > 0 &&
                            t("invDetail.fee", {
                                amount: fmt(
                                    txn.fees ?? 0,
                                    txn.currency || nativeCurrency,
                                ),
                            })}
                        {(txn.fees ?? 0) > 0 && (txn.taxes ?? 0) > 0 && " · "}
                        {(txn.taxes ?? 0) > 0 &&
                            t("invDetail.tax", {
                                amount: fmt(
                                    txn.taxes ?? 0,
                                    txn.currency || nativeCurrency,
                                ),
                            })}
                    </p>
                )}
            </div>

            <div className="flex items-center gap-1">
                {!nestedEdit ? (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={(event) => onEdit(txn, event)}
                        aria-label={t("aria.editTransaction")}
                    >
                        <Pencil className="h-4 w-4" />
                    </Button>
                ) : (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={t("aria.editTransaction")}
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={editDialogOpen}
                        onClick={(event) => onEdit(txn, event)}
                    >
                        <Pencil className="h-4 w-4" />
                    </Button>
                )}
                <Button
                    size="icon"
                    variant="ghost"
                    className="icon-touch-target shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => onDelete(txn)}
                    aria-label={t("aria.deleteTransaction")}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
            </div>
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
            <div style={{ paddingTop, paddingBottom }}>
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
    onAddTransaction,
    onEditInvestment,
    onEditTransaction,
}: Props) {
    const [open, setOpen] = useState(false);

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

    const { deleteTransaction } = usePortfolio();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
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
    const fxSummary = isForeignCurrency
        ? apiSummary?.summaries.find((s) => s.id === investment.id)
        : undefined;

    // FX-aware realized/unrealized P&L in the target currency, computed here so the
    // dialog renders identically wherever it is opened (overview, stocks, crypto,
    // …) instead of depending on the caller to pass it in.
    const computeFxAwarePnl = useFxAwarePnl(targetCurrency);
    const fxAwarePnl = isForeignCurrency
        ? computeFxAwarePnl(investment)
        : undefined;

    // The same add-transaction control appears in three spots (overview footer,
    // empty-transactions CTA, transactions footer) — build it once.
    const addTransactionControl = onAddTransaction ? (
        <Button
            size="sm"
            className="gap-1.5"
            onClick={() => onAddTransaction(investment)}
        >
            {t("portfolio.addTransaction")}
        </Button>
    ) : (
        // Same button AddPortfolioTxnDialog renders as its own default trigger; it
        // only opens the lifted dialog below instead of being that dialog's trigger,
        // so it also carries by hand the opener semantics DialogTrigger used to add.
        <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={addTxnOpen}
            onClick={openNested(setAddTxnOpen)}
        >
            <Plus className="h-4 w-4" /> {t("form.addTransaction.title")}
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

    return (
        <>
            <Dialog
                open={open}
                onOpenChange={(v) => {
                    if (v) setNestedMounted(true);
                    setOpen(v);
                }}
            >
                <DialogTrigger asChild>
                    {trigger ?? (
                        <Button size="sm" variant="ghost" className="gap-1.5">
                            <Eye className="h-4 w-4" /> {t("invDetail.trigger")}
                        </Button>
                    )}
                </DialogTrigger>
                <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <div className="flex items-center gap-2">
                            {investment.symbol && (
                                <span className="font-mono font-bold text-lg">
                                    {investment.symbol}
                                </span>
                            )}
                            <DialogTitle className="text-xl">
                                {investment.symbol ? (
                                    <TextLink
                                        to={`/research/market?symbol=${encodeURIComponent(investment.symbol)}&investmentId=${investment.id}`}
                                    >
                                        {investment.name}
                                    </TextLink>
                                ) : (
                                    investment.name
                                )}
                            </DialogTitle>
                            <Badge variant="secondary">
                                {getAssetClassLabel(t, investment.assetClass)}
                            </Badge>
                            <div className="ml-auto flex items-center gap-1.5">
                                {onEditInvestment ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="gap-1.5"
                                        onClick={() =>
                                            onEditInvestment(investment)
                                        }
                                    >
                                        <Pencil className="h-4 w-4" />{" "}
                                        {t("common.edit")}
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="gap-1.5"
                                        type="button"
                                        aria-haspopup="dialog"
                                        aria-expanded={editInvestmentOpen}
                                        onClick={openNested(
                                            setEditInvestmentOpen,
                                        )}
                                    >
                                        <Pencil className="h-4 w-4" />{" "}
                                        {t("common.edit")}
                                    </Button>
                                )}
                            </div>
                        </div>
                        <DialogDescription className="sr-only">
                            {investment.name}
                        </DialogDescription>
                    </DialogHeader>

                    <Tabs defaultValue="overview" className="mt-4">
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
                            className="space-y-4 mt-4"
                        >
                            {/* Key Metrics */}
                            <div className="grid grid-cols-2 gap-3">
                                <Card>
                                    <CardContent className="pt-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                                            <Banknote className="h-4 w-4" />
                                            {t("invDetail.currentValue")}
                                        </div>
                                        <p className="text-2xl font-bold tabular-nums">
                                            {fmt(
                                                investment.currentValue,
                                                investment.currency,
                                            )}
                                        </p>
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardContent className="pt-4">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                                            {investment.totalGain >= 0 ? (
                                                <TrendingUp className="h-4 w-4 text-gain" />
                                            ) : (
                                                <TrendingDown className="h-4 w-4 text-loss" />
                                            )}
                                            {t("invDetail.totalGainLoss")}
                                        </div>
                                        <p
                                            className={cn(
                                                "text-2xl font-bold tabular-nums",
                                                investment.totalGain >= 0
                                                    ? "text-gain"
                                                    : "text-loss",
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
                                                "text-sm tabular-nums",
                                                investment.gainLossPercent >= 0
                                                    ? "text-gain"
                                                    : "text-loss",
                                            )}
                                        >
                                            {investment.gainLossPercent >= 0
                                                ? "+"
                                                : ""}
                                            {fmtNum(investment.gainLossPercent)}
                                            %
                                        </p>
                                    </CardContent>
                                </Card>
                            </div>

                            {/* Detailed Breakdown */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle level={3} variant="sm">
                                        {t("invDetail.breakdown")}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div className="space-y-2">
                                            <div className="flex justify-between py-1.5 border-b border-border/50">
                                                <span className="text-muted-foreground">
                                                    {t("invDetail.totalCost")}
                                                </span>
                                                <span className="font-medium tabular-nums">
                                                    {fmt(
                                                        investment.totalBuyCost,
                                                        investment.currency,
                                                    )}
                                                </span>
                                            </div>

                                            {unitBased && (
                                                <>
                                                    <div className="flex justify-between py-1.5 border-b border-border/50">
                                                        <span className="text-muted-foreground">
                                                            {t(
                                                                "invDetail.unitsHeld",
                                                            )}
                                                        </span>
                                                        <span className="font-medium tabular-nums">
                                                            {fmtNum(
                                                                investment.totalUnits,
                                                                4,
                                                            )}
                                                        </span>
                                                    </div>
                                                    <div className="flex justify-between py-1.5 border-b border-border/50">
                                                        <span className="text-muted-foreground">
                                                            {t(
                                                                "invDetail.avgCostPerUnit",
                                                            )}
                                                        </span>
                                                        <span className="font-medium tabular-nums">
                                                            {fmt(
                                                                investment.avgCostBasis,
                                                                investment.currency,
                                                                2,
                                                            )}
                                                        </span>
                                                    </div>
                                                    {investment.currentPrice && (
                                                        <div className="flex justify-between py-1.5 border-b border-border/50">
                                                            <span className="text-muted-foreground">
                                                                {t(
                                                                    "invDetail.currentPrice",
                                                                )}
                                                            </span>
                                                            <span className="font-medium tabular-nums">
                                                                {fmt(
                                                                    investment.currentPrice,
                                                                    investment.currency,
                                                                    2,
                                                                )}
                                                            </span>
                                                        </div>
                                                    )}
                                                </>
                                            )}

                                            {fixedIncome &&
                                                investment.interestRate && (
                                                    <div className="flex justify-between py-1.5 border-b border-border/50">
                                                        <span className="text-muted-foreground">
                                                            {t(
                                                                "invDetail.interestRate",
                                                            )}
                                                        </span>
                                                        <span className="font-medium tabular-nums">
                                                            {fmtNum(
                                                                investment.interestRate,
                                                            )}
                                                            %
                                                        </span>
                                                    </div>
                                                )}

                                            {realEstate &&
                                                investment.municipality && (
                                                    <div className="flex justify-between py-1.5 border-b border-border/50">
                                                        <span className="text-muted-foreground">
                                                            {t(
                                                                "invDetail.municipality",
                                                            )}
                                                        </span>
                                                        <span className="font-medium tabular-nums">
                                                            {
                                                                investment.municipality
                                                            }
                                                        </span>
                                                    </div>
                                                )}

                                            {realEstate &&
                                                (investment.cadastral_income ||
                                                    investment.cadastral_income ===
                                                        0) && (
                                                    <div className="flex justify-between py-1.5 border-b border-border/50">
                                                        <span className="text-muted-foreground">
                                                            {t(
                                                                "invDetail.cadastralIncome",
                                                            )}
                                                        </span>
                                                        <span className="font-medium tabular-nums">
                                                            {fmt(
                                                                investment.cadastral_income ||
                                                                    0,
                                                                investment.currency,
                                                            )}
                                                        </span>
                                                    </div>
                                                )}

                                            {realEstate &&
                                                (investment.municipality_tax_rate ||
                                                    investment.municipality_tax_rate ===
                                                        0) && (
                                                    <div className="flex justify-between py-1.5 border-b border-border/50">
                                                        <span className="text-muted-foreground">
                                                            {t(
                                                                "invDetail.municipalityTaxRate",
                                                            )}
                                                        </span>
                                                        <span className="font-medium tabular-nums">
                                                            {fmtNum(
                                                                investment.municipality_tax_rate ||
                                                                    0,
                                                            )}
                                                            %
                                                        </span>
                                                    </div>
                                                )}
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex justify-between py-1.5 border-b border-border/50">
                                                <span className="text-muted-foreground flex items-center gap-1">
                                                    <ArrowUpRight className="h-3 w-3 text-gain" />
                                                    {t(
                                                        "invDetail.realizedGain",
                                                    )}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "font-medium tabular-nums",
                                                        investment.realizedGain >=
                                                            0
                                                            ? "text-gain"
                                                            : "text-loss",
                                                    )}
                                                >
                                                    <Money
                                                        amount={
                                                            investment.realizedGain
                                                        }
                                                        currency={
                                                            investment.currency
                                                        }
                                                        signed
                                                    />
                                                </span>
                                            </div>
                                            {fxAwarePnl && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground text-xs">
                                                        {t(
                                                            "invDetail.fxAwareRealized",
                                                            {
                                                                currency:
                                                                    targetCurrency,
                                                            },
                                                        )}
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "font-medium tabular-nums",
                                                            fxAwarePnl.realizedTarget >=
                                                                0
                                                                ? "text-gain"
                                                                : "text-loss",
                                                        )}
                                                    >
                                                        <Money
                                                            amount={
                                                                fxAwarePnl.realizedTarget
                                                            }
                                                            currency={
                                                                targetCurrency
                                                            }
                                                            signed
                                                        />
                                                    </span>
                                                </div>
                                            )}
                                            <div className="flex justify-between py-1.5 border-b border-border/50">
                                                <span className="text-muted-foreground flex items-center gap-1">
                                                    <Clock className="h-3 w-3" />
                                                    {t(
                                                        "invDetail.unrealizedGain",
                                                    )}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "font-medium tabular-nums",
                                                        investment.unrealizedGain >=
                                                            0
                                                            ? "text-gain"
                                                            : "text-loss",
                                                    )}
                                                >
                                                    <Money
                                                        amount={
                                                            investment.unrealizedGain
                                                        }
                                                        currency={
                                                            investment.currency
                                                        }
                                                        signed
                                                    />
                                                </span>
                                            </div>
                                            {fxAwarePnl && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground text-xs">
                                                        {t(
                                                            "invDetail.fxAwareUnrealized",
                                                            {
                                                                currency:
                                                                    targetCurrency,
                                                            },
                                                        )}
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "font-medium tabular-nums",
                                                            fxAwarePnl.unrealizedTarget >=
                                                                0
                                                                ? "text-gain"
                                                                : "text-loss",
                                                        )}
                                                    >
                                                        <Money
                                                            amount={
                                                                fxAwarePnl.unrealizedTarget
                                                            }
                                                            currency={
                                                                targetCurrency
                                                            }
                                                            signed
                                                        />
                                                        <span className="text-xs ml-1 opacity-70">
                                                            {fxAwarePnl.unrealizedPercent >=
                                                            0
                                                                ? "+"
                                                                : ""}
                                                            {fmtNum(
                                                                fxAwarePnl.unrealizedPercent,
                                                            )}
                                                            %
                                                        </span>
                                                    </span>
                                                </div>
                                            )}

                                            {investment.totalIncome > 0 && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">
                                                        {t(
                                                            "invDetail.totalIncome",
                                                        )}
                                                    </span>
                                                    <span className="font-medium tabular-nums text-gain">
                                                        <Money
                                                            amount={
                                                                investment.totalIncome
                                                            }
                                                            currency={
                                                                investment.currency
                                                            }
                                                            signed
                                                        />
                                                    </span>
                                                </div>
                                            )}

                                            {(investment.totalFees > 0 ||
                                                investment.totalTaxes > 0) && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">
                                                        {t(
                                                            "invDetail.feesAndTaxes",
                                                        )}
                                                    </span>
                                                    <span className="font-medium tabular-nums text-loss">
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
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* FX attribution — invested at purchase-date rates, gain split
                  into asset performance vs currency effect */}
                            {fxSummary &&
                                typeof fxSummary.fxGain === "number" && (
                                    <Card className="!border-primary/50 bg-primary/5">
                                        <CardContent className="pt-4 space-y-2">
                                            <p className="text-sm font-semibold text-muted-foreground">
                                                {t("invDetail.fxAttribution")}
                                            </p>
                                            <div className="flex justify-between py-1 border-b border-border/50 text-sm">
                                                <span className="text-muted-foreground">
                                                    {t(
                                                        "portfolio.nativeValue",
                                                        {
                                                            currency:
                                                                nativeCurrency,
                                                        },
                                                    )}
                                                </span>
                                                <span className="font-medium tabular-nums">
                                                    {fmt(
                                                        fxSummary.nativeCurrentValue ??
                                                            investment.currentValue,
                                                        nativeCurrency,
                                                    )}
                                                </span>
                                            </div>
                                            <div className="flex justify-between py-1 border-b border-border/50 text-sm">
                                                <span className="text-muted-foreground">
                                                    {t(
                                                        "invDetail.investedAtHistoricalRates",
                                                        {
                                                            currency:
                                                                targetCurrency,
                                                        },
                                                    )}
                                                </span>
                                                <span className="font-medium tabular-nums">
                                                    {fmt(
                                                        fxSummary.totalInvested,
                                                        targetCurrency,
                                                    )}
                                                </span>
                                            </div>
                                            <div className="flex justify-between py-1 border-b border-border/50 text-sm">
                                                <span className="text-muted-foreground">
                                                    {t("portfolio.assetGain")}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "font-medium tabular-nums",
                                                        (fxSummary.assetGain ??
                                                            0) >= 0
                                                            ? "text-gain"
                                                            : "text-loss",
                                                    )}
                                                >
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
                                                </span>
                                            </div>
                                            <div className="flex justify-between py-1 text-sm">
                                                <span className="text-muted-foreground">
                                                    {t("portfolio.fxEffect")}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "font-medium tabular-nums",
                                                        fxSummary.fxGain >= 0
                                                            ? "text-gain"
                                                            : "text-loss",
                                                    )}
                                                >
                                                    <Money
                                                        amount={
                                                            fxSummary.fxGain
                                                        }
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed
                                                    />
                                                </span>
                                            </div>
                                            {fxSummary.usedFallbackRate && (
                                                <p className="text-xs text-warning">
                                                    {t(
                                                        "portfolio.fxFallbackNote",
                                                    )}
                                                </p>
                                            )}
                                        </CardContent>
                                    </Card>
                                )}

                            {/* Fixed Income Projections */}
                            {fixedIncome &&
                                investment.projectedAnnualInterest > 0 && (
                                    <Card className="!border-primary/50 bg-primary/5">
                                        <CardContent className="pt-4">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                                                        <Percent className="h-4 w-4" />
                                                        {t(
                                                            "portfolio.projectedAnnualInterest",
                                                        )}
                                                    </p>
                                                    <p className="text-lg font-bold text-primary tabular-nums">
                                                        <Money
                                                            amount={
                                                                investment.projectedAnnualInterest
                                                            }
                                                            currency={
                                                                investment.currency
                                                            }
                                                            signed
                                                        />
                                                    </p>
                                                </div>
                                                {investment.accruedInterest >
                                                    0 && (
                                                    <div className="text-right">
                                                        <p className="text-sm text-muted-foreground">
                                                            {t(
                                                                "portfolio.accruedUnpaid",
                                                            )}
                                                        </p>
                                                        <p className="text-lg font-bold text-gain tabular-nums">
                                                            <Money
                                                                amount={
                                                                    investment.accruedInterest
                                                                }
                                                                currency={
                                                                    investment.currency
                                                                }
                                                                signed
                                                            />
                                                        </p>
                                                    </div>
                                                )}
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}

                            {/* Real Estate Appreciation */}
                            {realEstate &&
                                investment.totalAppreciation !== 0 && (
                                    <Card className="!border-accent/50 bg-accent/5">
                                        <CardContent className="pt-4 flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-muted-foreground">
                                                    {t(
                                                        "invDetail.totalAppreciation",
                                                    )}
                                                </p>
                                                <p
                                                    className={cn(
                                                        "text-lg font-bold tabular-nums",
                                                        investment.totalAppreciation >=
                                                            0
                                                            ? "text-gain"
                                                            : "text-loss",
                                                    )}
                                                >
                                                    <Money
                                                        amount={
                                                            investment.totalAppreciation
                                                        }
                                                        currency={
                                                            investment.currency
                                                        }
                                                        signed
                                                    />
                                                </p>
                                            </div>
                                            {investment.totalIncome > 0 && (
                                                <div className="text-right">
                                                    <p className="text-sm text-muted-foreground">
                                                        {t(
                                                            "portfolio.rentalIncome",
                                                        )}
                                                    </p>
                                                    <p className="text-lg font-bold text-gain tabular-nums">
                                                        <Money
                                                            amount={
                                                                investment.totalIncome
                                                            }
                                                            currency={
                                                                investment.currency
                                                            }
                                                            signed
                                                        />
                                                    </p>
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>
                                )}

                            <div className="flex justify-end">
                                {addTransactionControl}
                            </div>
                        </TabsContent>

                        <TabsContent value="transactions" className="mt-4">
                            {investment.transactions.length === 0 ? (
                                <div className="text-center py-8 text-muted-foreground">
                                    <p>{t("invDetail.noTransactions")}</p>
                                    <div className="mt-4">
                                        {addTransactionControl}
                                    </div>
                                </div>
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
                                />
                            )}

                            {investment.transactions.length > 0 && (
                                <div className="flex justify-end mt-4 pt-4 border-t border-border">
                                    {addTransactionControl}
                                </div>
                            )}
                        </TabsContent>
                    </Tabs>
                </DialogContent>
            </Dialog>
            {/* Siblings of the dialog above, not children of its content: they must
          outlive its dismissal for their drafts to survive one. */}
            {nestedMounted && !onAddTransaction && (
                <AddPortfolioTxnDialog
                    investment={investment}
                    open={addTxnOpen}
                    onOpenChange={setAddTxnOpen}
                    returnFocusRef={nestedOpenerRef}
                />
            )}
            {nestedMounted && !onEditInvestment && (
                <EditInvestmentDialog
                    investment={investment}
                    open={editInvestmentOpen}
                    onOpenChange={setEditInvestmentOpen}
                    returnFocusRef={nestedOpenerRef}
                />
            )}
            {nestedMounted && !onEditTransaction && editTxn && (
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
