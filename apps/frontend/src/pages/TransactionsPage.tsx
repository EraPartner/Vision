import { PAGE_ICONS } from "@/lib/pageIcons";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Import } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    useCreateTransaction,
    useUpdateTransaction,
    useDeleteTransaction,
} from "@/hooks/useTransactions";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useDebounce, SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import { useTransactionListData } from "@/features/transactions/hooks/useTransactionListData";
import { FilterBanner } from "@/features/transactions/components/FilterBanner";
import { TransactionsToolbar } from "@/features/transactions/components/TransactionsToolbar";
import { TransactionsTable } from "@/features/transactions/components/TransactionsTable";
import { AddTransactionButton } from "@/features/transactions/components/AddTransactionSheet";
import {
    OPTIONAL_TRANSACTION_COLUMNS,
    TRANSACTIONS_COLUMNS_PAGE_KEY,
    datePresetFor,
    datePresetRange,
    type DatePreset,
} from "@/features/transactions/transactionColumns";
import { useWidgetVisibility } from "@/hooks/useWidgetVisibility";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNeedsCategoryCount } from "@/hooks/useNeedsCategoryCount";
import { useAccounts } from "@/hooks/useAccounts";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import {
    TransactionSearchSuggestions,
    type QuickFilterParams,
} from "@/features/transactions/components/TransactionSearchSuggestions";
import { TransactionInspector } from "@/features/transactions/components/TransactionInspector";
import { TransactionQuickLook } from "@/features/transactions/components/TransactionQuickLook";
import {
    BulkActionsBar,
    type BulkSelectionMode,
} from "@/features/transactions/components/bulk/BulkActionsBar";
import type {
    TableTransaction,
    InfoEditableField,
} from "@/features/transactions/types";
import type { BulkTransactionFilter } from "@/types/api";
import { PageShell } from "@/components/shared/PageShell";

/** Router state Home passes to land on one row (`navigate("/transactions", { state })`). */
export interface TransactionsLocationState {
    selectTransactionId?: number;
}

export default function TransactionsPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const pageSize = appSettings.defaultPageSize;
    const loadMoreOffset = Math.min(50, Math.max(15, Math.floor(pageSize / 5)));
    const [searchParams, setSearchParams] = useSearchParams();
    const location = useLocation();
    const navigate = useNavigate();
    const [showAll, setShowAll] = useState(false);
    // The inspector docks beside the list from the lg breakpoint; below it the
    // same content is presented as a sheet.
    const inspectorDocked = useMediaQuery("(min-width: 1024px)");
    const columnVisibility = useWidgetVisibility(
        TRANSACTIONS_COLUMNS_PAGE_KEY,
        OPTIONAL_TRANSACTION_COLUMNS,
    );
    const { data: needsCategoryCount } = useNeedsCategoryCount();
    const { data: accountsData } = useAccounts({ active: "true" });
    const [search, setSearch] = useState(
        () => searchParams.get("search") || "",
    );
    // Palette-driven searches land as ?search= while already mounted (same
    // pathname → no remount), so mirror later param changes into state.
    const searchParam = searchParams.get("search");
    useEffect(() => {
        if (searchParam !== null) setSearch(searchParam);
    }, [searchParam]);
    // ...and mirror typing back out, so the search term is as shareable and
    // reload-safe as the ten filter params beside it. Debounced on the same
    // delay the query already uses, so a param write costs no extra request;
    // `{ replace: true }` keeps per-keystroke entries out of history.
    const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
    useEffect(() => {
        // Only write once the debounce has caught up with the live value.
        // Mid-flight the two disagree, and writing the stale one would stomp a
        // param-driven search (the palette effect above) with the previous term.
        if (debouncedSearch !== search) return;
        if (searchParam === (search || null)) return;
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                if (search) next.set("search", search);
                else next.delete("search");
                return next;
            },
            { replace: true },
        );
    }, [debouncedSearch, search, searchParam, setSearchParams]);
    // The selected row drives the inspector; it is derived from the list on
    // every render, so local patches and refetches flow into it.
    const [selectedId, setSelectedId] = useState<number | null>(() => {
        const state = location.state as TransactionsLocationState | null;
        return state?.selectTransactionId ?? null;
    });
    const [quickLookTransaction, setQuickLookTransaction] =
        useState<TableTransaction | null>(null);
    const selectReturnFocusRef = useRef<HTMLElement | null>(null);
    const quickLookReturnFocusRef = useRef<HTMLElement | null>(null);

    const rememberFocusedElement = useCallback(() => {
        return document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
    }, []);
    const selectRow = useCallback(
        (transaction: TableTransaction | null) => {
            if (transaction) {
                const active = rememberFocusedElement();
                if (active?.getAttribute("role") === "row")
                    selectReturnFocusRef.current = active;
            }
            setSelectedId(transaction?.id ?? null);
        },
        [rememberFocusedElement],
    );
    const closeInspector = useCallback(() => {
        setSelectedId(null);
        requestAnimationFrame(() => selectReturnFocusRef.current?.focus());
    }, []);
    const openQuickLook = useCallback(
        (transaction: TableTransaction) => {
            quickLookReturnFocusRef.current = rememberFocusedElement();
            setQuickLookTransaction(transaction);
        },
        [rememberFocusedElement],
    );
    const closeQuickLook = useCallback(() => {
        setQuickLookTransaction(null);
        requestAnimationFrame(() => quickLookReturnFocusRef.current?.focus());
    }, []);

    const recipientIdFilter = searchParams.get("recipient_id")
        ? Number(searchParams.get("recipient_id"))
        : undefined;
    const categoryIdFilter = searchParams.get("category_id")
        ? Number(searchParams.get("category_id"))
        : undefined;
    const uncategorisedFilter =
        searchParams.get("uncategorised") === "true" || undefined;
    const transactionIdFilter = searchParams.get("transaction_id")
        ? Number(searchParams.get("transaction_id"))
        : undefined;
    const filterLabel = searchParams.get("filter_label") || undefined;
    const startDateFilter = searchParams.get("start_date") || undefined;
    const endDateFilter = searchParams.get("end_date") || undefined;
    // account_id is the preferred account filter (exact FK match, ADR-088);
    // bank_account stays as a substring escape hatch (e.g. the string-keyed
    // bank-balances widget until its Phase C re-grain).
    const accountIdFilter = searchParams.get("account_id")
        ? Number(searchParams.get("account_id"))
        : undefined;
    const bankAccountFilter = searchParams.get("bank_account") || undefined;
    const transactionTypeRaw = searchParams.get("transaction_type");
    const transactionTypeFilter =
        transactionTypeRaw === "income" || transactionTypeRaw === "expense"
            ? transactionTypeRaw
            : undefined;
    const amountSignedFilter = searchParams.get("amount_signed") === "true";
    const parseAmountParam = (raw: string | null) => {
        if (!raw) return undefined;
        // Preserve the sign — the backend decides magnitude vs signed from
        // amount_signed; for unsigned filters the value is already non-negative.
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
    };
    const amountMinFilter = parseAmountParam(searchParams.get("amount_min"));
    const amountMaxFilter = parseAmountParam(searchParams.get("amount_max"));
    // Memoized on the raw param strings: a fresh array identity per render
    // would ripple through the currentFilter memo into the selection-clear
    // effect below, which setStates — an unconditional render→effect→render
    // loop ("Maximum update depth exceeded") for any multi-value filter URL
    // (general-category pivot drills, tag filters).
    const categoryIdsRaw = searchParams.get("category_ids");
    const categoryIdsFilter = useMemo(
        () =>
            categoryIdsRaw
                ? categoryIdsRaw
                      .split(",")
                      .map(Number)
                      .filter((n) => Number.isFinite(n) && n > 0)
                : undefined,
        [categoryIdsRaw],
    );
    const tagsRaw = searchParams.get("tags");
    const tagsFilter = useMemo(
        () => (tagsRaw ? tagsRaw.split(",").filter(Boolean) : undefined),
        [tagsRaw],
    );

    const {
        allItems,
        refetch,
        setAllItems,
        totalItems,
        isLoading,
        error,
        isFetchingMore,
        hasMoreRef,
        sortKey,
        sortDir,
        handleSortChange,
        loadMore,
        setEditing,
        cancelTableEditingRef,
    } = useTransactionListData({
        showAll,
        search,
        pageSize,
        transactionIdFilter,
        recipientIdFilter,
        categoryIdFilter,
        categoryIdsFilter,
        uncategorisedFilter,
        startDateFilter,
        endDateFilter,
        transactionTypeFilter,
        amountMinFilter,
        amountMaxFilter,
        amountSignedFilter,
        tagsFilter,
        accountIdFilter,
        bankAccountFilter,
    });

    const createMutation = useCreateTransaction();
    const updateMutation = useUpdateTransaction();
    const deleteMutation = useDeleteTransaction();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [selectionMode, setSelectionMode] =
        useState<BulkSelectionMode>("ids");

    const currentFilter = useMemo<BulkTransactionFilter>(
        () => ({
            transaction_id: transactionIdFilter,
            recipient_id: recipientIdFilter,
            category_id: categoryIdFilter,
            category_ids: categoryIdsFilter,
            uncategorised: uncategorisedFilter,
            start_date: startDateFilter,
            end_date: endDateFilter,
            transaction_type: transactionTypeFilter,
            amount_min: amountMinFilter,
            amount_max: amountMaxFilter,
            amount_signed: amountSignedFilter || undefined,
            tags: tagsFilter,
            account_id: accountIdFilter,
            bank_account: bankAccountFilter,
            search: search || undefined,
            active: !showAll,
        }),
        [
            transactionIdFilter,
            recipientIdFilter,
            categoryIdFilter,
            categoryIdsFilter,
            uncategorisedFilter,
            startDateFilter,
            endDateFilter,
            transactionTypeFilter,
            amountMinFilter,
            amountMaxFilter,
            amountSignedFilter,
            tagsFilter,
            accountIdFilter,
            bankAccountFilter,
            search,
            showAll,
        ],
    );

    useEffect(() => {
        // Clear selection whenever the filter set changes — stale ids could no
        // longer be in the visible list and "select all matching" would refer to
        // a different cohort.
        setSelectedIds(new Set());
        setSelectionMode("ids");
    }, [currentFilter]);

    const applyTransactionLocalPatch = useCallback(
        (transactionId: number, patch: Record<string, unknown>) => {
            setAllItems((prev) =>
                prev.map((item) => {
                    if (item.id !== transactionId) return item;
                    return { ...item, ...patch };
                }),
            );
        },
        [setAllItems],
    );

    const applyInfoFieldLocally = useCallback(
        (
            transactionId: number,
            field: InfoEditableField,
            value: string | number | undefined,
            accountId?: number | null,
        ) => {
            setAllItems((prev) =>
                prev.map((item) => {
                    if (item.id !== transactionId) return item;
                    switch (field) {
                        case "date": {
                            const date =
                                value === undefined ? undefined : String(value);
                            return { ...item, transaction_date: date, date };
                        }
                        case "memo":
                            return {
                                ...item,
                                memo:
                                    value === undefined
                                        ? undefined
                                        : String(value),
                            };
                        case "amount":
                            return {
                                ...item,
                                amount:
                                    typeof value === "number"
                                        ? value
                                        : item.amount,
                            };
                        case "currency":
                            return {
                                ...item,
                                currency:
                                    value === undefined
                                        ? undefined
                                        : String(value),
                            };
                        case "bank":
                            return {
                                ...item,
                                bank:
                                    value === undefined
                                        ? undefined
                                        : String(value),
                                account_id: accountId,
                            };
                        case "comment":
                            return {
                                ...item,
                                comment:
                                    value === undefined
                                        ? undefined
                                        : String(value),
                            };
                        default:
                            return item;
                    }
                }),
            );
        },
        [setAllItems],
    );

    const handleDelete = async (id: number, description?: string) => {
        const ok = await confirm({
            title: t("txPage.delete.title"),
            description: t("txPage.delete.desc", { desc: description ?? "" }),
            confirmLabel: t("txPage.delete.confirm"),
            variant: "destructive",
        });
        if (!ok) return;
        if (selectedId === id) setSelectedId(null);
        deleteMutation.mutate(id);
    };

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({ id, data: { is_active: !currentActive } });
    };

    const handleDuplicate = useCallback(
        (row: TableTransaction) => {
            const raw = allItems.find((item) => item.id === row.id);
            const transactionDate = (
                ((raw?.transaction_date as string | undefined) || row.date) ??
                ""
            ).split("T")[0];
            const accountId = raw?.account_id ?? row.accountId;
            const recipientId =
                raw?.recipient_id ?? (row.recipientId || undefined);
            if (recipientId == null || !transactionDate || accountId == null)
                return;
            createMutation.mutate({
                transaction_date: transactionDate,
                account_id: accountId,
                recipient_id: recipientId,
                memo: raw?.memo ?? (row.memo || undefined),
                amount: raw?.amount ?? row.amount,
                currency: raw?.currency || row.currency,
                category_id: raw?.category_id ?? undefined,
                comment: raw?.comment ?? undefined,
                tags: row.tags?.length
                    ? row.tags.map((tag) => tag.slug)
                    : undefined,
                allow_duplicate: true,
                // balance deliberately not copied — the running balance belongs to
                // the original row, not a new transaction.
            });
        },
        [allItems, createMutation],
    );

    const handleFilterByRecipient = useCallback(
        (row: TableTransaction) => {
            if (!row.recipientId) return;
            // Fresh filter set: "show all from X" replaces every active filter,
            // including the text search (kept in local state, so clear it too).
            setSearch("");
            setSearchParams({
                recipient_id: String(row.recipientId),
                filter_label: row.recipient,
            });
        },
        [setSearchParams],
    );

    // Account filter (WP-B4, §3 F6): merges into the active filter set like the
    // quick filters — account_id is the FK-exact filter (ADR-088), filter_label
    // feeds the FilterBanner's human-readable descriptor.
    const handleAccountFilterChange = useCallback(
        (selection: { id: number; label: string } | null) => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (selection) {
                    next.set("account_id", String(selection.id));
                    next.set("filter_label", selection.label);
                } else {
                    next.delete("account_id");
                    next.delete("filter_label");
                }
                return next;
            });
        },
        [setSearchParams],
    );

    const handleCategoryFilterChange = useCallback(
        (selection: { id: number; label: string } | null) => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete("category_ids");
                if (selection) {
                    next.set("category_id", String(selection.id));
                    next.set("filter_label", selection.label);
                } else {
                    next.delete("category_id");
                    next.delete("filter_label");
                }
                return next;
            });
        },
        [setSearchParams],
    );

    const handleDatePresetChange = useCallback(
        (preset: DatePreset) => {
            const range = datePresetRange(preset, new Date());
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (range) {
                    next.set("start_date", range.start);
                    next.set("end_date", range.end);
                } else {
                    next.delete("start_date");
                    next.delete("end_date");
                }
                return next;
            });
        },
        [setSearchParams],
    );

    const handleTypeChange = useCallback(
        (type: "income" | "expense" | undefined) => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (type) next.set("transaction_type", type);
                else next.delete("transaction_type");
                return next;
            });
        },
        [setSearchParams],
    );

    const handleNeedsCategoryChange = useCallback(
        (on: boolean) => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (on) next.set("uncategorised", "true");
                else next.delete("uncategorised");
                return next;
            });
        },
        [setSearchParams],
    );

    // Quick-filter suggestions merge their params into the active filter set
    // (additive — e.g. "all expense" + "amount 10–50") rather than replacing it.
    const handleApplyQuickFilter = useCallback(
        (params: QuickFilterParams) => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                for (const [key, value] of Object.entries(params)) {
                    if (value === undefined || value === "") next.delete(key);
                    else next.set(key, value);
                }
                return next;
            });
        },
        [setSearchParams],
    );

    const handleUpdate = (sourceIndex: number, updated: TableTransaction) => {
        const originalTransaction = allItems[sourceIndex];
        if (!originalTransaction) return;
        updateMutation.mutate(
            {
                id: originalTransaction.id,
                data: {
                    transaction_date: updated.date,
                    memo: updated.memo,
                    amount: updated.amount,
                    currency: updated.currency,
                    // balance deliberately not sent — bank-stamped import data
                    // (ADR-094); the backend PATCH whitelist drops it anyway.
                    comment: updated.comment,
                },
            },
            {
                onSuccess: (serverUpdated) => {
                    applyTransactionLocalPatch(originalTransaction.id, {
                        amount: serverUpdated.amount,
                        memo: serverUpdated.memo,
                        bank_account: serverUpdated.bank_account,
                        currency: serverUpdated.currency,
                        balance: serverUpdated.balance,
                        comment: serverUpdated.comment,
                        transaction_date: serverUpdated.transaction_date,
                        category_id: serverUpdated.category_id,
                        category_name: serverUpdated.category_name,
                        recipient_id: serverUpdated.recipient_id,
                        recipient_name: serverUpdated.recipient_name,
                    });
                },
            },
        );
    };

    const handleSelectCategory = (
        transactionId: number,
        catId: number | null,
        categoryName: string | null,
    ) => {
        applyTransactionLocalPatch(transactionId, {
            category_id: catId,
            category_name: categoryName ?? t("txPage.field.uncategorized"),
        });
        updateMutation.mutate(
            {
                id: transactionId,
                // Explicit null clears the category on the backend; `?? undefined`
                // dropped the key from the PATCH body ({}), so the onSuccess echo
                // re-applied the OLD category over the optimistic patch and the
                // clear visually reverted.
                data: { category_id: catId },
            },
            {
                onSuccess: (updated) => {
                    applyTransactionLocalPatch(transactionId, {
                        category_id: updated.category_id,
                        category_name: updated.category_name,
                    });
                },
            },
        );
    };

    const handleSelectRecipient = (
        transactionId: number,
        recipientId: number | null,
        recipientName: string | null,
    ) => {
        applyTransactionLocalPatch(transactionId, {
            recipient_id: recipientId,
            recipient_name: recipientName ?? t("txPage.field.unknown"),
        });
        updateMutation.mutate(
            {
                id: transactionId,
                // Same null-to-clear semantics as category above.
                data: { recipient_id: recipientId },
            },
            {
                onSuccess: (updated) => {
                    applyTransactionLocalPatch(transactionId, {
                        recipient_id: updated.recipient_id,
                        recipient_name: updated.recipient_name,
                    });
                },
            },
        );
    };

    const accountLabels = useMemo(
        () =>
            new Map(
                accountsData?.items.map((account) => [
                    account.id,
                    account.display_name || account.name,
                ]) ?? [],
            ),
        [accountsData],
    );

    const transactions: TableTransaction[] = useMemo(
        () =>
            allItems.map((tx) => ({
                id: tx.id,
                date:
                    (tx.transaction_date as string | undefined) ||
                    tx.date ||
                    "",
                memo: tx.memo || "",
                category:
                    (tx.category_name as string | undefined) ||
                    t("txPage.field.uncategorized"),
                categoryId: tx.category_id ?? undefined,
                recipient:
                    (tx.recipient_name as string | undefined) ||
                    t("txPage.field.unknown"),
                recipientId: tx.recipient_id ?? 0,
                bank: (tx.bank_account as string | undefined) || tx.bank || "",
                bankLabel: tx.account_id
                    ? accountLabels.get(tx.account_id)
                    : undefined,
                accountId: tx.account_id ?? undefined,
                amount: tx.amount ?? 0,
                // Matches the backend window's COALESCE(currency, 'EUR').
                currency: tx.currency ?? "EUR",
                runningBalance: tx.running_balance ?? undefined,
                balance: tx.balance ?? undefined,
                comment: tx.comment || "",
                is_active: tx.is_active ?? true,
                tags: tx.tags ?? [],
            })),
        [allItems, t, accountLabels],
    );
    const selectedTransaction = useMemo(
        () =>
            selectedId == null
                ? null
                : (transactions.find((tx) => tx.id === selectedId) ?? null),
        [transactions, selectedId],
    );
    // A row that left the loaded list (deleted, filtered out) closes the
    // inspector rather than showing stale details.
    useEffect(() => {
        if (
            selectedId != null &&
            !isLoading &&
            allItems.length > 0 &&
            !selectedTransaction
        ) {
            setSelectedId(null);
        }
    }, [selectedId, selectedTransaction, isLoading, allItems.length]);

    const datePreset = datePresetFor(
        startDateFilter,
        endDateFilter,
        new Date(),
    );
    const customDateLabel =
        startDateFilter || endDateFilter
            ? `${startDateFilter ? formatDateStringWithAppSettings(startDateFilter, appSettings.dateFormat) : "…"} – ${endDateFilter ? formatDateStringWithAppSettings(endDateFilter, appSettings.dateFormat) : "…"}`
            : undefined;
    const accountCount = accountsData?.total ?? accountsData?.items.length;
    const headerSubtitle =
        accountCount != null && accountCount > 0
            ? t("txPage.countInAccounts", { n: totalItems, m: accountCount })
            : t("txPage.tableSubtitle", { n: totalItems });
    const headerActions = (
        <>
            <Button asChild variant="outline">
                <Link to="/import">
                    <Import className="h-4 w-4" aria-hidden="true" />
                    {t("txPage.importLink")}
                </Link>
            </Button>
            <AddTransactionButton
                onCreated={(created) => {
                    setSelectedId(created.id);
                    navigate("/transactions", {
                        replace: true,
                        state: { selectTransactionId: created.id },
                    });
                }}
            />
        </>
    );

    if (isLoading) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("txPage.title")}
                    icon={PAGE_ICONS["/transactions"]}
                    actions={headerActions}
                />
                <Card {...loadingSurfaceProps}>
                    <CardHeader className="pb-3">
                        <Skeleton className="h-6 w-44" />
                        <Skeleton className="h-4 w-28 mt-1" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {[...Array(8)].map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (error) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("txPage.title")}
                    icon={PAGE_ICONS["/transactions"]}
                />
                <Card>
                    <CardContent>
                        <PageError
                            message={t("txPage.error", {
                                msg: apiErrorToMessage(error, t),
                            })}
                            onRetry={() => void refetch()}
                        />
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    const inspector = (
        <TransactionInspector
            transaction={selectedTransaction}
            presentation={inspectorDocked ? "docked" : "sheet"}
            onClose={closeInspector}
            onApplyLocal={applyInfoFieldLocally}
            onSelectCategory={handleSelectCategory}
            onSelectRecipient={handleSelectRecipient}
            onDuplicate={handleDuplicate}
            onFilterByRecipient={handleFilterByRecipient}
            onToggleActive={toggleActive}
            onDelete={handleDelete}
            updatePending={updateMutation.isPending}
            deletePending={deleteMutation.isPending}
        />
    );

    return (
        <>
            <PageShell className="">
                <PageHeader
                    title={t("txPage.title")}
                    subtitle={headerSubtitle}
                    icon={PAGE_ICONS["/transactions"]}
                    actions={headerActions}
                />

                <TransactionsToolbar
                    accountIdFilter={accountIdFilter}
                    onAccountChange={handleAccountFilterChange}
                    categoryIdFilter={categoryIdFilter}
                    onCategoryChange={handleCategoryFilterChange}
                    datePreset={datePreset}
                    customDateLabel={customDateLabel}
                    onDatePresetChange={handleDatePresetChange}
                    transactionTypeFilter={transactionTypeFilter}
                    onTypeChange={handleTypeChange}
                    needsCategory={!!uncategorisedFilter}
                    needsCategoryCount={needsCategoryCount}
                    onNeedsCategoryChange={handleNeedsCategoryChange}
                    showAll={showAll}
                    onShowAllChange={setShowAll}
                    columns={OPTIONAL_TRANSACTION_COLUMNS}
                    isColumnVisible={columnVisibility.isVisible}
                    setColumnVisible={columnVisibility.setWidgetVisible}
                    onResetColumns={columnVisibility.resetToDefaults}
                />

                <FilterBanner
                    transactionIdFilter={transactionIdFilter}
                    recipientIdFilter={recipientIdFilter}
                    categoryIdFilter={categoryIdFilter}
                    categoryIdsFilter={categoryIdsFilter}
                    startDateFilter={startDateFilter}
                    endDateFilter={endDateFilter}
                    transactionTypeFilter={transactionTypeFilter}
                    amountMinFilter={amountMinFilter}
                    amountMaxFilter={amountMaxFilter}
                    amountSignedFilter={amountSignedFilter}
                    searchFilter={search || undefined}
                    filterLabel={filterLabel}
                    accountIdFilter={accountIdFilter}
                    bankAccountFilter={bankAccountFilter}
                    tagsFilter={tagsFilter}
                    onClear={() =>
                        setSearchParams((prev) => {
                            // Clears filters only. Sort moved into the URL for
                            // shareability, but it is view state rather than a
                            // filter chip — carry it across so "clear" does not
                            // silently reorder the list (it never used to).
                            const next = new URLSearchParams();
                            const sortKeyParam = prev.get("sort_key");
                            const sortDirParam = prev.get("sort_dir");
                            if (sortKeyParam && sortDirParam) {
                                next.set("sort_key", sortKeyParam);
                                next.set("sort_dir", sortDirParam);
                            }
                            return next;
                        })
                    }
                    onClearTags={() => {
                        setSearchParams((prev) => {
                            const next = new URLSearchParams(prev);
                            next.delete("tags");
                            return next;
                        });
                    }}
                />

                <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                        <TransactionsTable
                            transactions={transactions}
                            allItems={allItems}
                            serverMode={{
                                sort: {
                                    onChange: handleSortChange,
                                    key: sortKey,
                                    dir: sortDir,
                                },
                                search: {
                                    onChange: setSearch,
                                    value: search,
                                    placeholder: t("txPage.searchPlaceholder"),
                                    suggestions: ({ query, close }) => (
                                        <TransactionSearchSuggestions
                                            query={query}
                                            onApply={handleApplyQuickFilter}
                                            close={close}
                                        />
                                    ),
                                },
                                pagination: {
                                    totalItems,
                                    isFetchingMore,
                                    hasMore: hasMoreRef.current,
                                    loadMoreOffset,
                                    onLoadMore: loadMore,
                                },
                            }}
                            onRowUpdate={handleUpdate}
                            onSelectRow={selectRow}
                            selectedRowId={selectedId}
                            onQuickLook={openQuickLook}
                            onDuplicate={handleDuplicate}
                            onFilterByRecipient={handleFilterByRecipient}
                            onToggleActive={toggleActive}
                            onDelete={handleDelete}
                            onSelectCategory={handleSelectCategory}
                            onSelectRecipient={handleSelectRecipient}
                            cancelEditingRef={cancelTableEditingRef}
                            onEditingChange={setEditing}
                            selectedIds={selectedIds}
                            onSelectionChange={setSelectedIds}
                            isColumnVisible={columnVisibility.isVisible}
                            actions={
                                selectedIds.size === 0 ? undefined : (
                                    <BulkActionsBar
                                        selectedIds={selectedIds}
                                        selectedTransactions={transactions
                                            .filter((row) =>
                                                selectedIds.has(row.id),
                                            )
                                            .map((row) => {
                                                const peer = allItems.find(
                                                    (item) =>
                                                        item.id === row.id,
                                                )?.transfer_peer_id;
                                                return {
                                                    ...row,
                                                    transferPeerId:
                                                        peer == null
                                                            ? undefined
                                                            : typeof peer ===
                                                                "number"
                                                              ? peer
                                                              : -1,
                                                };
                                            })}
                                        selectionMode={selectionMode}
                                        totalMatching={totalItems}
                                        visibleItemCount={allItems.length}
                                        filter={currentFilter}
                                        onClearSelection={() => {
                                            setSelectedIds(new Set());
                                            setSelectionMode("ids");
                                        }}
                                        onPromoteToFilterMode={() =>
                                            setSelectionMode("filter")
                                        }
                                    />
                                )
                            }
                            updatePending={updateMutation.isPending}
                            deletePending={deleteMutation.isPending}
                        />
                    </div>
                    {inspectorDocked && inspector}
                </div>
            </PageShell>
            {!inspectorDocked && inspector}
            <ConfirmDialog />
            <TransactionQuickLook
                transaction={quickLookTransaction}
                onClose={closeQuickLook}
            />
        </>
    );
}
