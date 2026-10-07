import { useState, useEffect } from "react";
import { Money } from "@/components/shared/Money";
import { toast } from "sonner";
import logger from "@/lib/logger";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { List } from "@/components/ui/list";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/shared/DatePicker";
import {
    formatDateStringWithAppSettings,
    parseLocalDateFromYmd,
    toYmd,
} from "@/lib/dateUtils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { getRecipient } from "@/lib/api/recipients";
import { cn } from "@/lib/utils";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { useLinkTransactionCandidates } from "@/hooks/usePlannedMatchSuggestions";

interface LinkTransactionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    payment: PlannedPayment | null;
    onExecute: (
        paymentId: number,
        txId: number,
        executionDate?: string,
    ) => Promise<void>;
}

export function LinkTransactionDialog({
    open,
    onOpenChange,
    payment,
    onExecute,
}: LinkTransactionDialogProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    const [txSearchQuery, setTxSearchQuery] = useState("");
    const [amountToleranceInput, setAmountToleranceInput] = useState("5");
    const [actionLoading, setActionLoading] = useState(false);
    const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
    const [txFilters, setTxFilters] = useState({
        start_date: "",
        end_date: "",
        bank_account: "",
        recipient_name: "",
        recipient_id: null as number | null,
        uncategorised: false,
        active: true,
        matchAmount: true,
        amountTolerancePct: 5,
    });

    useEffect(() => {
        if (payment) {
            // Search a window that opens ~2 weeks before the due date: direct debits
            // often post a few days early, and a strict on/after-due-date lower bound
            // hid them entirely. Upper bound stays open so late debits still appear.
            const due = payment.due_date
                ? parseLocalDateFromYmd(payment.due_date)
                : undefined;
            const windowStart = due
                ? toYmd(
                      new Date(
                          due.getFullYear(),
                          due.getMonth(),
                          due.getDate() - 14,
                      ),
                  )
                : undefined;
            setTxFilters((prev) => ({
                ...prev,
                recipient_name: payment.recipient || prev.recipient_name,
                recipient_id: null,
                start_date: windowStart || prev.start_date,
                bank_account: payment.bank_account || prev.bank_account,
            }));
        }
    }, [payment]);

    useEffect(() => {
        if (!payment?.recipient_id) return;
        let cancelled = false;
        getRecipient(payment.recipient_id)
            .then((r) => {
                if (cancelled) return;
                const clusterRootId = r.primary_recipient_id ?? r.id;
                setTxFilters((prev) => ({
                    ...prev,
                    recipient_id: clusterRootId,
                }));
            })
            .catch(() => {
                /* fall back to name-based search */
            });
        return () => {
            cancelled = true;
        };
    }, [payment?.recipient_id]);

    // Debounce the query-key INPUT (not the fetch): txFilters churns at open time
    // (the payment + recipient effects rewrite it), so trail it by 250ms and only
    // let the settled value drive the query. Starts null so the first fetch also
    // waits the full debounce — preserving the deliberate 250ms delay — and resets
    // to null while closed so reopening re-debounces. txSearchQuery is deliberately
    // absent here: it only drives client-side filtering below, never the API.
    const [debouncedFilters, setDebouncedFilters] = useState<
        typeof txFilters | null
    >(null);
    useEffect(() => {
        if (!open || !payment) {
            setDebouncedFilters(null);
            return;
        }
        const timer = setTimeout(() => setDebouncedFilters(txFilters), 250);
        return () => clearTimeout(timer);
    }, [open, payment, txFilters]);

    const {
        data: candidateTxs = [],
        isLoading: txLoading,
        isError: txError,
        error: txErrorObj,
    } = useLinkTransactionCandidates(payment, debouncedFilters, open);

    useEffect(() => {
        if (txError) logger.error("Failed to fetch transactions:", txErrorObj);
    }, [txError, txErrorObj]);

    const handleClose = () => {
        onOpenChange(false);
        setSelectedTxId(null);
        setTxSearchQuery("");
        // candidateTxs is now query-cached; closing disables the query
        // (debouncedFilters resets to null) so it re-fetches on reopen.
    };

    const handleLinkAndExecute = async () => {
        if (!payment || !selectedTxId) return;
        // The execution date is the linked transaction's own date — i.e. when the
        // money actually moved. (Falls back to the backend's app-today if absent.)
        const txDate = candidateTxs.find(
            (x) => x.id === selectedTxId,
        )?.transaction_date;
        const execDate = txDate
            ? txDate.includes("T")
                ? txDate.split("T")[0]
                : txDate
            : undefined;
        setActionLoading(true);
        try {
            await onExecute(payment.id, selectedTxId, execDate);
            toast.success(
                t("plannedPage.toast.executed", { name: payment.name }),
            );
            handleClose();
        } catch (err) {
            logger.error("Failed to link/execute planned payment:", err);
            toast.error(
                t("plannedPage.link.executeFailed", {
                    msg: apiErrorToMessage(err, t),
                }),
            );
        } finally {
            setActionLoading(false);
        }
    };

    const filteredCandidates = candidateTxs.filter((tx) => {
        if (txSearchQuery) {
            const q = txSearchQuery.toLowerCase();
            if (!(
                (tx.memo || "").toLowerCase().includes(q) ||
                (tx.recipient_name || "").toLowerCase().includes(q) ||
                String(tx.amount).includes(q)
            )) {
                return false;
            }
        }
        if (
            txFilters.matchAmount &&
            payment &&
            typeof payment.amount === "number"
        ) {
            const planned = Math.abs(payment.amount);
            const txAmt = Math.abs(tx.amount);
            const tol = Math.max(
                1,
                planned * (txFilters.amountTolerancePct / 100),
            );
            if (Math.abs(txAmt - planned) > tol) return false;
        }
        return true;
    });

    const selectedTx = selectedTxId
        ? candidateTxs.find((x) => x.id === selectedTxId)
        : undefined;
    const filterGroupClass =
        "space-y-3 rounded-card corner-continuous bg-foreground/[0.04] p-3";

    return (
        <Dialog
            open={open}
            onOpenChange={(isOpen) => {
                if (!isOpen) handleClose();
            }}
        >
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {t("plannedPage.link.title", {
                            name: payment?.name ?? "",
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("plannedPage.link.intro")}
                        {payment?.due_date && (
                            <>
                                {" "}
                                {t("plannedPage.link.dueOn", {
                                    date: formatDateStringWithAppSettings(
                                        payment.due_date,
                                        appSettings.dateFormat,
                                    ),
                                })}
                                .
                            </>
                        )}
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4">
                    <div className="grid gap-1.5">
                        <Label
                            htmlFor="link-transaction-search"
                            className="sr-only"
                        >
                            {t("plannedPage.link.searchPlaceholder")}
                        </Label>
                        <Input
                            id="link-transaction-search"
                            placeholder={t("plannedPage.link.searchPlaceholder")}
                            value={txSearchQuery}
                            onChange={(e) => setTxSearchQuery(e.target.value)}
                        />
                    </div>

                    <section
                        aria-labelledby="link-transaction-filters"
                        className={filterGroupClass}
                    >
                        <h3
                            id="link-transaction-filters"
                            className="eyebrow text-label-secondary"
                        >
                            {t("plannedPage.link.filters")}
                        </h3>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="grid gap-1.5">
                                <Label htmlFor="tx-start-date">
                                    {t("importPage.startDate")}
                                </Label>
                                <DatePicker
                                    id="tx-start-date"
                                    value={
                                        txFilters.start_date
                                            ? parseLocalDateFromYmd(
                                                  txFilters.start_date,
                                              )
                                            : undefined
                                    }
                                    onChange={(date) =>
                                        setTxFilters({
                                            ...txFilters,
                                            start_date: date ? toYmd(date) : "",
                                        })
                                    }
                                    placeholder={t("plannedPage.link.pickDate")}
                                    allowClear
                                    clearLabel={t("common.clear")}
                                />
                            </div>
                            <div className="grid gap-1.5">
                                <Label htmlFor="tx-end-date">
                                    {t("importPage.endDate")}
                                </Label>
                                <DatePicker
                                    id="tx-end-date"
                                    value={
                                        txFilters.end_date
                                            ? parseLocalDateFromYmd(
                                                  txFilters.end_date,
                                              )
                                            : undefined
                                    }
                                    onChange={(date) =>
                                        setTxFilters({
                                            ...txFilters,
                                            end_date: date ? toYmd(date) : "",
                                        })
                                    }
                                    placeholder={t("plannedPage.link.pickDate")}
                                    allowClear
                                    clearLabel={t("common.clear")}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="grid gap-1.5">
                                <Label htmlFor="tx-bank-account">
                                    {t("importPage.bankAccount")}
                                </Label>
                                <Input
                                    id="tx-bank-account"
                                    placeholder={t("importPage.bankAccount")}
                                    value={txFilters.bank_account}
                                    onChange={(e) =>
                                        setTxFilters({
                                            ...txFilters,
                                            bank_account: e.target.value,
                                        })
                                    }
                                />
                            </div>
                            <div className="grid gap-1.5">
                                <Label htmlFor="tx-recipient">
                                    {t("recipientsPage.col.recipient")}
                                </Label>
                                <Input
                                    id="tx-recipient"
                                    placeholder={t("recipientsPage.search")}
                                    value={txFilters.recipient_name}
                                    onChange={(e) =>
                                        setTxFilters({
                                            ...txFilters,
                                            recipient_name: e.target.value,
                                            recipient_id: null,
                                        })
                                    }
                                />
                                {txFilters.recipient_id != null && (
                                    <p className="type-footnote text-label-secondary">
                                        {t("plannedPage.link.includesLinked")}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="tx-uncategorised"
                                    checked={txFilters.uncategorised}
                                    onCheckedChange={(v: boolean) =>
                                        setTxFilters({
                                            ...txFilters,
                                            uncategorised: v,
                                        })
                                    }
                                />
                                <Label htmlFor="tx-uncategorised">
                                    {t("plannedPage.link.uncategorised")}
                                </Label>
                            </div>
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="tx-active"
                                    checked={txFilters.active}
                                    onCheckedChange={(v: boolean) =>
                                        setTxFilters({
                                            ...txFilters,
                                            active: v,
                                        })
                                    }
                                />
                                <Label htmlFor="tx-active">
                                    {t("plannedPage.link.activeOnly")}
                                </Label>
                            </div>
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="tx-match-amount"
                                    checked={txFilters.matchAmount}
                                    onCheckedChange={(v: boolean) =>
                                        setTxFilters({
                                            ...txFilters,
                                            matchAmount: v,
                                        })
                                    }
                                />
                                <Label htmlFor="tx-match-amount">
                                    {t("plannedPage.link.matchAmount")}
                                </Label>
                                <Input
                                    id="tx-amount-tolerance"
                                    type="number"
                                    className="w-16"
                                    value={amountToleranceInput}
                                    onChange={(e) => {
                                        const raw = e.target.value;
                                        setAmountToleranceInput(raw);
                                        const parsed = Number(raw);
                                        if (
                                            raw !== "" &&
                                            Number.isFinite(parsed) &&
                                            parsed >= 0
                                        ) {
                                            setTxFilters({
                                                ...txFilters,
                                                amountTolerancePct: parsed,
                                            });
                                        }
                                    }}
                                    onBlur={() => {
                                        const parsed =
                                            Number(amountToleranceInput);
                                        if (
                                            amountToleranceInput === "" ||
                                            !Number.isFinite(parsed) ||
                                            parsed < 0
                                        ) {
                                            setAmountToleranceInput(
                                                String(
                                                    txFilters.amountTolerancePct,
                                                ),
                                            );
                                        }
                                    }}
                                    min={0}
                                    step={1}
                                    disabled={!txFilters.matchAmount}
                                    aria-label={t(
                                        "importPage.toleranceAriaLabel",
                                    )}
                                />
                                <span className="type-body text-label-secondary">
                                    %
                                </span>
                            </div>
                        </div>
                    </section>

                    <div className="grid gap-2">
                        <h3
                            id="link-transaction-candidates"
                            className="eyebrow text-label-secondary"
                        >
                            {t("plannedPage.link.candidates")}
                        </h3>
                        {txLoading ? (
                            <p
                                role="status"
                                className="rounded-card corner-continuous border border-border/60 px-4 py-6 text-center type-body text-label-secondary"
                            >
                                {t("plannedPage.link.loading")}
                            </p>
                        ) : filteredCandidates.length === 0 ? (
                            <p className="rounded-card corner-continuous border border-border/60 px-4 py-6 text-center type-body text-label-secondary">
                                {t("plannedPage.link.empty")}
                            </p>
                        ) : (
                            <RadioGroup
                                aria-labelledby="link-transaction-candidates"
                                value={
                                    selectedTxId != null
                                        ? String(selectedTxId)
                                        : ""
                                }
                                onValueChange={(value) =>
                                    setSelectedTxId(Number(value))
                                }
                                className="block"
                            >
                                <List className="max-h-64 overflow-y-auto">
                                    {filteredCandidates.map((tx) => {
                                        const inputId = `link-tx-${tx.id}`;
                                        return (
                                            <li key={tx.id}>
                                                <label
                                                    htmlFor={inputId}
                                                    className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04]"
                                                >
                                                    <RadioGroupItem
                                                        id={inputId}
                                                        value={String(tx.id)}
                                                    />
                                                    <span className="flex min-w-0 flex-1 flex-col">
                                                        <span className="truncate type-body font-medium text-foreground">
                                                            {tx.memo ||
                                                                tx.recipient_name ||
                                                                t(
                                                                    "plannedPage.link.txFallback",
                                                                    {
                                                                        id: tx.id,
                                                                    },
                                                                )}
                                                        </span>
                                                        <span className="truncate type-footnote text-label-secondary">
                                                            {[
                                                                tx.recipient_name,
                                                                tx.transaction_date
                                                                    ? formatDateStringWithAppSettings(
                                                                          tx.transaction_date,
                                                                          appSettings.dateFormat,
                                                                      )
                                                                    : null,
                                                            ]
                                                                .filter(Boolean)
                                                                .join(" · ")}
                                                        </span>
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "shrink-0 type-body font-semibold tabular-nums",
                                                            tx.amount < 0
                                                                ? "text-foreground"
                                                                : "text-gain",
                                                        )}
                                                    >
                                                        <Money
                                                            amount={tx.amount}
                                                            currency={
                                                                tx.currency
                                                            }
                                                            signed
                                                        />
                                                    </span>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </List>
                            </RadioGroup>
                        )}
                    </div>

                    {selectedTx && (
                        <p
                            className="type-footnote text-label-secondary"
                            aria-live="polite"
                        >
                            {t("plannedPage.link.recordedOn", {
                                date: selectedTx.transaction_date
                                    ? formatDateStringWithAppSettings(
                                          selectedTx.transaction_date,
                                          appSettings.dateFormat,
                                      )
                                    : "—",
                            })}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={handleClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        onClick={handleLinkAndExecute}
                        disabled={actionLoading || !selectedTxId}
                    >
                        {t("plannedPage.link.linkAndExecute")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
