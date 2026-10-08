import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, Copy, Filter, Pencil, Split, ToggleLeft, ToggleRight, Trash2, X } from "lucide-react";
import {
    Inspector,
    InspectorBody,
    InspectorClose,
    InspectorFooter,
    InspectorHeader,
    InspectorSection,
    InspectorTitle,
} from "@/components/ui/inspector";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/shared/DatePicker";
import { AccountCombobox } from "@/components/shared/AccountCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { AttachmentPanel } from "@/components/shared/AttachmentPanel";
import { TagInput } from "@/components/shared/TagInput";
import { Money } from "@/components/shared/Money";
import { SplitTransactionDialog } from "@/features/splits/SplitTransactionDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useAccounts } from "@/hooks/useAccounts";
import { useRecipient, useUpdateRecipient } from "@/hooks/useRecipients";
import {
    useBulkUpdateTransactions,
    useUpdateTransaction,
} from "@/hooks/useTransactions";
import { moneyAmount, ymdDateString } from "@/lib/forms/schemas";
import { formatEditableNumber } from "@/utils/currency";
import {
    formatDateStringWithAppSettings,
    parseLocalDateFromYmd,
    toYmd,
} from "@/lib/dateUtils";
import { getCategoryChartColor } from "@/utils/categoryColors";
import { cn } from "@/lib/utils";
import type { TransactionUpdate } from "@/types/api";
import type { InfoEditableField, TableTransaction } from "../types";
import { amountClass } from "../amountClass";
import { useUncategorisedCountForRecipient } from "../hooks/useUncategorisedCountForRecipient";

const editDateSchema = ymdDateString("validation.required");

export interface TransactionInspectorProps {
    transaction: TableTransaction | null;
    /** Docked beside the list (desktop) or presented as a sheet (narrow). */
    presentation: "docked" | "sheet";
    onClose: () => void;
    onApplyLocal: (
        transactionId: number,
        field: InfoEditableField,
        value: string | number | undefined,
        accountId?: number | null,
    ) => void;
    onSelectCategory: (
        transactionId: number,
        categoryId: number | null,
        categoryName: string | null,
    ) => void;
    onSelectRecipient: (
        transactionId: number,
        recipientId: number | null,
        recipientName: string | null,
    ) => void;
    onDuplicate: (row: TableTransaction) => void;
    onFilterByRecipient: (row: TableTransaction) => void;
    onToggleActive: (id: number, currentActive: boolean) => void;
    onDelete: (id: number, description?: string) => void;
    updatePending: boolean;
    deletePending: boolean;
}

/**
 * Transaction inspector (ADR-181): the selected row's details beside the
 * list, replacing the modal details dialog. Fields edit in place with the
 * same PATCH contract as before; the footer carries every row action the
 * context menu offers so each one is also reachable by pointer.
 */
export function TransactionInspector(props: TransactionInspectorProps) {
    const { t } = useLanguage();
    const { transaction, presentation, onClose } = props;
    const title = t("txPage.detailsTitle");

    if (presentation === "sheet") {
        return (
            <Sheet
                open={!!transaction}
                onOpenChange={(open) => {
                    if (!open) onClose();
                }}
            >
                <SheetContent
                    side="right"
                    className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
                    aria-label={title}
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>{title}</SheetTitle>
                        <SheetDescription>{title}</SheetDescription>
                    </SheetHeader>
                    {transaction && (
                        <InspectorContent key={transaction.id} {...props} transaction={transaction} />
                    )}
                </SheetContent>
            </Sheet>
        );
    }

    if (!transaction) return null;
    return (
        <Inspector
            aria-label={title}
            onClose={onClose}
            className="sticky top-4 max-h-[calc(100vh-6rem)] w-[332px]"
        >
            <InspectorContent key={transaction.id} {...props} transaction={transaction} />
        </Inspector>
    );
}

interface FieldSpec {
    key: string;
    label: string;
    /** Rendered display value; also the row's visibility gate (falsy → row hidden). */
    value?: ReactNode;
    editable?: boolean;
    editField?: InfoEditableField;
    editValue?: string;
    editType?: "text" | "number" | "date";
    multiline?: boolean;
}

function InspectorContent({
    transaction: txn,
    presentation,
    onClose,
    onApplyLocal,
    onSelectCategory,
    onSelectRecipient,
    onDuplicate,
    onFilterByRecipient,
    onToggleActive,
    onDelete,
    updatePending,
    deletePending,
}: TransactionInspectorProps & { transaction: TableTransaction }) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const updateMutation = useUpdateTransaction();
    const updateRecipient = useUpdateRecipient();
    const bulkUpdate = useBulkUpdateTransactions();
    const { data: accountsData } = useAccounts({ active: "true" });
    const tagsLabelId = useId();

    const [editingField, setEditingField] = useState<InfoEditableField | null>(null);
    const [editingValue, setEditingValue] = useState("");
    const [editingAccountId, setEditingAccountId] = useState<number | null>(null);

    // Tag chips track local state (the row snapshot never carries tag edits
    // back), re-seeded whenever a different row's tags arrive.
    const [tagSlugs, setTagSlugs] = useState<string[]>(
        () => txn.tags?.map((tag) => tag.slug) ?? [],
    );
    useEffect(() => {
        setTagSlugs(txn.tags?.map((tag) => tag.slug) ?? []);
    }, [txn.tags]);

    const recipientId = txn.recipientId || undefined;
    const uncategorised =
        !txn.categoryId || txn.category === t("txPage.field.uncategorized");
    const { data: recipient } = useRecipient(recipientId);
    const { data: uncategorisedCount } =
        useUncategorisedCountForRecipient(recipientId);
    const otherUncategorised = Math.max(
        0,
        (uncategorisedCount ?? 0) - (uncategorised ? 1 : 0),
    );
    // "Always use X": offered once the row has a category the payee's rule
    // does not already apply.
    const canSetUsual =
        !!recipient &&
        !!txn.categoryId &&
        recipient.default_category_id !== txn.categoryId;

    const startEdit = (field: InfoEditableField, currentValue: string) => {
        setEditingField(field);
        setEditingValue(currentValue);
        setEditingAccountId(field === "bank" ? (txn.accountId ?? null) : null);
    };
    const cancelEdit = () => {
        setEditingField(null);
        setEditingValue("");
        setEditingAccountId(null);
    };

    const saveEdit = async () => {
        if (!editingField) return;
        const trimmed = editingValue.trim();
        const payload: TransactionUpdate = {};
        let localValue: string | number | undefined = trimmed;
        let localAccountId: number | null | undefined;

        if (editingField === "amount") {
            const parsed = moneyAmount(
                { required: "addTxn.invalidAmount", invalid: "addTxn.invalidAmount" },
                appSettings.numberFormat,
            ).safeParse(trimmed);
            if (!parsed.success) return;
            payload.amount = parsed.data;
            localValue = parsed.data;
        } else if (editingField === "date") {
            if (!editDateSchema.safeParse(trimmed).success) return;
            payload.transaction_date = trimmed;
        } else if (editingField === "memo") {
            // A cleared field is sent as an explicit null (dropping the key
            // would PATCH {} and leave the server value in place).
            payload.memo = trimmed || null;
            localValue = trimmed || "";
        } else if (editingField === "currency") {
            // currency is NOT NULL: a blank input means no change.
            payload.currency = trimmed || undefined;
        } else if (editingField === "bank") {
            if (!trimmed) {
                payload.account_id = null;
                localAccountId = null;
            } else {
                const normalized = trimmed.toLowerCase();
                const account =
                    (accountsData?.items ?? []).find((a) => a.id === editingAccountId) ??
                    (accountsData?.items ?? []).find(
                        (a) => a.name.trim().toLowerCase() === normalized,
                    );
                if (!account) return;
                payload.account_id = account.id;
                localAccountId = account.id;
                localValue = account.name;
            }
        } else if (editingField === "comment") {
            payload.comment = trimmed || null;
            localValue = trimmed || "";
        }

        await updateMutation.mutateAsync({ id: txn.id, data: payload });
        if (editingField === "bank") {
            onApplyLocal(txn.id, editingField, localValue, localAccountId);
        } else {
            onApplyLocal(txn.id, editingField, localValue);
        }
        cancelEdit();
    };

    const fields: FieldSpec[] = [
        {
            key: "date",
            label: t("txPage.field.date"),
            value: txn.date
                ? formatDateStringWithAppSettings(txn.date, appSettings.dateFormat)
                : "—",
            editable: true,
            editField: "date",
            editValue: txn.date ? txn.date.split("T")[0] : "",
            editType: "date",
        },
        {
            key: "description",
            label: t("txPage.field.description"),
            value: txn.memo || undefined,
            editable: true,
            editField: "memo",
            editValue: txn.memo || "",
            editType: "text",
        },
        {
            key: "amount",
            label: t("txPage.field.amount"),
            value: <Money amount={txn.amount} currency={txn.currency} signed />,
            editable: true,
            editField: "amount",
            editValue: formatEditableNumber(txn.amount, appSettings.numberFormat),
            editType: "text",
        },
        {
            key: "currency",
            label: t("txPage.field.currency"),
            value: txn.currency,
            editable: true,
            editField: "currency",
            editValue: txn.currency || "",
            editType: "text",
        },
        {
            key: "bankAccount",
            label: t("txPage.field.bankAccount"),
            value: txn.bank,
            editable: true,
            editField: "bank",
            editValue: txn.bank || "",
            editType: "text",
        },
        {
            // Read-only: bank-stamped import data (ADR-094).
            key: "balance",
            label: t("txPage.field.balance"),
            value:
                txn.balance != null ? (
                    <Money amount={txn.balance} currency={txn.currency} />
                ) : undefined,
        },
        {
            key: "comment",
            label: t("txPage.field.comment"),
            value: txn.comment || undefined,
            editable: true,
            editField: "comment",
            editValue: txn.comment || "",
            editType: "text",
            multiline: true,
        },
        { key: "id", label: t("txPage.field.id"), value: String(txn.id) },
    ];

    const hasRecipient = !!txn.recipientId;
    const canDuplicate = hasRecipient && !!txn.date && !!txn.bank;
    const fieldRows = (
        <dl className="divide-y divide-border/50">
            {fields.map((field) =>
                field.value || field.editable ? (
                    <div key={field.key} className="flex items-center justify-between gap-3 py-2 type-body">
                        <dt className="shrink-0 text-label-secondary">
                            {field.editable && field.editField ? (
                                <label htmlFor={`transaction-info-${field.editField}`}>
                                    {field.label}
                                </label>
                            ) : (
                                field.label
                            )}
                        </dt>
                        <dd className="flex min-w-0 items-center gap-1 text-right">
                            {field.editable &&
                            field.editField &&
                            editingField === field.editField ? (
                                <form
                                    className="flex items-center gap-1"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void saveEdit();
                                    }}
                                >
                                    {field.editType === "date" ? (
                                        <DatePicker
                                            id={`transaction-info-${field.editField}`}
                                            value={
                                                editingValue
                                                    ? parseLocalDateFromYmd(editingValue)
                                                    : undefined
                                            }
                                            onChange={(d) =>
                                                setEditingValue(d ? toYmd(d) : "")
                                            }
                                            buttonClassName="h-8 w-36"
                                        />
                                    ) : field.editField === "bank" ? (
                                        <AccountCombobox
                                            id={`transaction-info-${field.editField}`}
                                            value={editingValue}
                                            onChange={setEditingValue}
                                            onAccountIdChange={setEditingAccountId}
                                            className="w-40"
                                        />
                                    ) : field.multiline ? (
                                        <Textarea
                                            id={`transaction-info-${field.editField}`}
                                            value={editingValue}
                                            rows={2}
                                            onChange={(e) => setEditingValue(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" && !e.shiftKey) {
                                                    e.preventDefault();
                                                    void saveEdit();
                                                }
                                            }}
                                            className="min-h-0 w-40"
                                        />
                                    ) : (
                                        <Input
                                            id={`transaction-info-${field.editField}`}
                                            type={field.editType ?? "text"}
                                            inputMode={
                                                field.editField === "amount"
                                                    ? "decimal"
                                                    : undefined
                                            }
                                            value={editingValue}
                                            onChange={(e) => setEditingValue(e.target.value)}
                                            className="h-8 w-36"
                                        />
                                    )}
                                    <Button
                                        type="submit"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8"
                                        aria-label={t("common.save")}
                                        title={t("common.save")}
                                        disabled={updateMutation.isPending}
                                    >
                                        <Check className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8"
                                        onClick={cancelEdit}
                                        disabled={updateMutation.isPending}
                                        title={t("common.cancel")}
                                        aria-label={t("aria.cancel")}
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </Button>
                                </form>
                            ) : (
                                <>
                                    <span
                                        className={cn(
                                            "min-w-0 break-words text-foreground tabular-nums",
                                            !field.value && "text-label-tertiary",
                                        )}
                                    >
                                        {field.value ?? "—"}
                                    </span>
                                    {field.editable && field.editField && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 text-label-secondary hover:text-foreground"
                                            onClick={() =>
                                                startEdit(field.editField!, field.editValue ?? "")
                                            }
                                            aria-label={t("common.editField", { field: field.label })}
                                            title={t("common.editField", { field: field.label })}
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                </>
                            )}
                        </dd>
                    </div>
                ) : null,
            )}
        </dl>
    );

    return (
        <>
            <InspectorHeader className={cn(presentation === "sheet" && "pt-6")}>
                <div className="min-w-0 flex-1">
                    <InspectorTitle title={txn.recipient}>{txn.recipient}</InspectorTitle>
                    <p className="type-footnote text-label-secondary">
                        {txn.date
                            ? formatDateStringWithAppSettings(txn.date, appSettings.dateFormat)
                            : "—"}
                        {txn.bank ? ` · ${txn.bank}` : ""}
                        {!txn.is_active ? ` · ${t("txPage.statusInactive")}` : ""}
                    </p>
                </div>
                {presentation === "docked" && <InspectorClose onClick={onClose} />}
            </InspectorHeader>
            <InspectorBody>
                <p
                    className={cn(
                        "type-large-title tabular-nums",
                        amountClass(txn.amount),
                        !txn.is_active && "line-through opacity-50",
                    )}
                >
                    <Money amount={txn.amount} currency={txn.currency} signed />
                </p>

                <InspectorSection label={t("txPage.inspector.classify")}>
                    <div className="space-y-2">
                        <div className="space-y-1">
                            <label htmlFor="transaction-info-category" className="type-footnote text-label-secondary">
                                {t("txPage.field.category")}
                            </label>
                            <div className="flex items-center gap-2">
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        "h-2.5 w-2.5 shrink-0 rounded-full",
                                        uncategorised && "border border-dashed border-label-tertiary",
                                    )}
                                    style={
                                        uncategorised
                                            ? undefined
                                            : { backgroundColor: getCategoryChartColor(txn.category) }
                                    }
                                />
                                <CategoryCombobox
                                    id="transaction-info-category"
                                    value={txn.categoryId ?? null}
                                    onSelect={(id, name) => onSelectCategory(txn.id, id, name)}
                                    className="h-9 flex-1"
                                    disabled={updatePending}
                                />
                            </div>
                        </div>
                        <div className="space-y-1">
                            <label htmlFor="transaction-info-recipient" className="type-footnote text-label-secondary">
                                {t("txPage.field.recipient")}
                            </label>
                            <RecipientCombobox
                                id="transaction-info-recipient"
                                value={txn.recipientId || null}
                                onSelect={(id, name) => onSelectRecipient(txn.id, id, name)}
                                className="h-9 w-full"
                                disabled={updatePending}
                            />
                        </div>
                    </div>
                    {recipient && (canSetUsual || otherUncategorised > 0) && (
                        <div className="space-y-2 rounded-control bg-foreground/[0.04] px-3 py-2 type-footnote text-label-secondary">
                            {otherUncategorised > 0 && txn.categoryId && (
                                <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <span>
                                        {t("txPage.inspector.othersNeedCategory", {
                                            count: otherUncategorised,
                                            name: recipient.name,
                                        })}
                                    </span>
                                    <Button
                                        variant="link"
                                        size="sm"
                                        className="h-auto p-0"
                                        disabled={bulkUpdate.isPending}
                                        onClick={() =>
                                            bulkUpdate.mutate({
                                                filter: {
                                                    recipient_id: recipient.id,
                                                    uncategorised: true,
                                                    active: true,
                                                },
                                                expected_count: uncategorisedCount ?? 0,
                                                fields: { category_id: txn.categoryId ?? null },
                                            })
                                        }
                                    >
                                        {t("txPage.inspector.useForAll", { count: otherUncategorised })}
                                    </Button>
                                </p>
                            )}
                            {canSetUsual && (
                                <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <span>
                                        {t("txPage.inspector.alwaysUseQuestion", {
                                            category: txn.category,
                                            name: recipient.name,
                                        })}
                                    </span>
                                    <Button
                                        variant="link"
                                        size="sm"
                                        className="h-auto p-0"
                                        disabled={updateRecipient.isPending}
                                        onClick={() =>
                                            updateRecipient.mutate({
                                                id: recipient.id,
                                                data: { default_category_id: txn.categoryId ?? null },
                                            })
                                        }
                                    >
                                        {t("txPage.inspector.alwaysUse")}
                                    </Button>
                                </p>
                            )}
                        </div>
                    )}
                    {recipient?.default_category_id &&
                        recipient.default_category_id === txn.categoryId && (
                            <p className="flex flex-wrap items-center justify-between gap-x-3 type-footnote text-label-secondary">
                                <span>
                                    {t("txPage.inspector.ruleApplies", {
                                        name: recipient.name,
                                        category: txn.category,
                                    })}
                                </span>
                                <Button asChild variant="link" size="sm" className="h-auto p-0">
                                    <Link to="/recipients">{t("txPage.inspector.editRule")}</Link>
                                </Button>
                            </p>
                        )}
                </InspectorSection>

                <InspectorSection label={t("txPage.inspector.details")}>
                    {fieldRows}
                </InspectorSection>

                <InspectorSection>
                    <h3 id={tagsLabelId} className="eyebrow">
                        {t("txPage.field.tags")}
                    </h3>
                    <TagInput
                        aria-labelledby={tagsLabelId}
                        value={tagSlugs}
                        onChange={async (slugs) => {
                            const previous = tagSlugs;
                            setTagSlugs(slugs);
                            try {
                                await updateMutation.mutateAsync({
                                    id: txn.id,
                                    data: { tags: slugs },
                                });
                            } catch {
                                setTagSlugs(previous);
                            }
                        }}
                        disabled={updateMutation.isPending}
                    />
                </InspectorSection>

                <InspectorSection>
                    <AttachmentPanel transactionId={txn.id} />
                </InspectorSection>
            </InspectorBody>
            <InspectorFooter className="flex-wrap justify-start gap-1">
                <SplitTransactionDialog
                    transactionId={txn.id}
                    transactionAmount={txn.amount}
                    transactionCurrency={txn.currency}
                    trigger={
                        <Button variant="ghost" size="sm" className="gap-1.5">
                            <Split className="h-4 w-4" />
                            {t("splitDialog.buttonTitle")}
                        </Button>
                    }
                />
                {canDuplicate && (
                    <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onDuplicate(txn)}>
                        <Copy className="h-4 w-4" />
                        {t("contextMenu.duplicate")}
                    </Button>
                )}
                {hasRecipient && (
                    <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onFilterByRecipient(txn)}>
                        <Filter className="h-4 w-4" />
                        {t("txPage.inspector.showAllFromPayee")}
                    </Button>
                )}
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    disabled={updatePending}
                    onClick={() => onToggleActive(txn.id, txn.is_active)}
                >
                    {txn.is_active ? <ToggleLeft className="h-4 w-4" /> : <ToggleRight className="h-4 w-4" />}
                    {txn.is_active ? t("contextMenu.markInactive") : t("contextMenu.markActive")}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={deletePending}
                    onClick={() => onDelete(txn.id, txn.memo || txn.recipient)}
                >
                    <Trash2 className="h-4 w-4" />
                    {t("contextMenu.delete")}
                </Button>
            </InspectorFooter>
        </>
    );
}
