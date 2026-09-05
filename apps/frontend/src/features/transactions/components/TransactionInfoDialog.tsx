import { useState, useEffect, type ReactNode } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Info, Pencil, Check, X } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useUpdateTransaction } from "@/hooks/useTransactions";
import { useAccounts } from "@/hooks/useAccounts";
import { Money } from "@/components/shared/Money";
import { moneyAmount, ymdDateString } from "@/lib/forms/schemas";
import {
    formatDateStringWithAppSettings,
    parseLocalDateFromYmd,
    toYmd,
} from "@/lib/dateUtils";
import { DatePicker } from "@/components/shared/DatePicker";
import { AttachmentPanel } from "@/components/shared/AttachmentPanel";
import { TagInput } from "@/components/shared/TagInput";
import type { TransactionUpdate } from "@/types/api";
import type { TableTransaction, InfoEditableField } from "../types";

// Inline single-field edits keep their original silent-block behavior (the
// row simply stays in edit mode), so these schemas' i18n-key messages are
// never rendered — the parse result is the contract. Amount accepts any
// locale-formatted finite number, 0 and negatives included (the sign flips
// expense/income); date must be a non-empty YYYY-MM-DD.
const editAmountSchema = moneyAmount({
    required: "addTxn.invalidAmount",
    invalid: "addTxn.invalidAmount",
});
const editDateSchema = ymdDateString("validation.required");

interface TransactionInfoDialogProps {
    infoTransaction: TableTransaction | null;
    onClose: () => void;
    onApplyLocal: (
        transactionId: number,
        field: InfoEditableField,
        value: string | number | undefined,
    ) => void;
}

export function TransactionInfoDialog({
    infoTransaction,
    onClose,
    onApplyLocal,
}: TransactionInfoDialogProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const updateMutation = useUpdateTransaction();
    // Account-name suggestions for the bank field (ADR-088). Writing the name keeps
    // the dual-write trigger's account_id link intact; free entry still creates new.
    const { data: accountsData } = useAccounts({ active: "all" });

    const [editingInfoField, setEditingInfoField] =
        useState<InfoEditableField | null>(null);
    const [editingInfoValue, setEditingInfoValue] = useState("");

    // `infoTransaction` is a frozen snapshot held by the parent page — tag edits
    // never flow back into it, so binding TagInput straight at the snapshot left
    // a removed chip stuck on screen (most visible when clearing the last tag).
    // Track slugs locally instead: re-seed when a different transaction opens
    // (its tags array is a fresh reference; unrelated field edits reuse the same
    // reference via spread, so they don't clobber an in-flight optimistic edit).
    const [tagSlugs, setTagSlugs] = useState<string[]>([]);
    useEffect(() => {
        setTagSlugs(infoTransaction?.tags?.map((tag) => tag.slug) ?? []);
    }, [infoTransaction?.tags]);

    const startInfoFieldEdit = (
        field: InfoEditableField,
        currentValue: string,
    ) => {
        setEditingInfoField(field);
        setEditingInfoValue(currentValue);
    };

    const cancelEdit = () => {
        setEditingInfoField(null);
        setEditingInfoValue("");
    };

    const saveInfoFieldEdit = async () => {
        if (!infoTransaction || !editingInfoField) return;
        const trimmed = editingInfoValue.trim();
        const payload: TransactionUpdate = {};
        let localValue: string | number | undefined = trimmed;

        if (editingInfoField === "amount") {
            const parsed = editAmountSchema.safeParse(trimmed);
            if (!parsed.success) return;
            payload.amount = parsed.data;
            localValue = parsed.data;
        } else if (editingInfoField === "date") {
            if (!editDateSchema.safeParse(trimmed).success) return;
            payload.transaction_date = trimmed;
        } else if (editingInfoField === "memo") {
            // Cleared fields must be SENT as explicit null — `|| undefined`
            // dropped the key, the PATCH body was {}, and onApplyLocal still
            // blanked the visible row: silent divergence until reload.
            payload.memo = trimmed || null;
            localValue = trimmed || "";
        } else if (editingInfoField === "currency") {
            // currency is NOT NULL at the DB level — a blanked input means
            // "no change", never "clear".
            payload.currency = trimmed || undefined;
        } else if (editingInfoField === "bank") {
            // null clears the label (and the 0066 trigger clears account_id).
            payload.bank_account = trimmed || null;
        } else if (editingInfoField === "comment") {
            payload.comment = trimmed || null;
            localValue = trimmed || "";
        }

        await updateMutation.mutateAsync({
            id: infoTransaction.id,
            data: payload,
        });
        onApplyLocal(infoTransaction.id, editingInfoField, localValue);
        cancelEdit();
    };

    return (
        <Dialog
            open={!!infoTransaction}
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                    cancelEdit();
                }
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Info className="h-4 w-4 text-muted-foreground" />
                        {t("txPage.detailsTitle")}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("txPage.detailsTitle")}
                    </DialogDescription>
                </DialogHeader>
                {infoTransaction &&
                    (() => {
                        const txn = infoTransaction;
                        const fields: Array<{
                            key: string;
                            label: string;
                            /** Rendered display value; also the row's visibility gate (falsy → row hidden). */
                            value?: ReactNode;
                            editable?: boolean;
                            editField?: InfoEditableField;
                            editValue?: string;
                            editType?: "text" | "number" | "date";
                        }> = [
                            {
                                key: "id",
                                label: t("txPage.field.id"),
                                value: String(txn.id),
                            },
                            {
                                key: "date",
                                label: t("txPage.field.date"),
                                value: txn.date
                                    ? formatDateStringWithAppSettings(
                                          txn.date,
                                          appSettings.dateFormat,
                                      )
                                    : "—",
                                editable: true,
                                editField: "date",
                                editValue: txn.date
                                    ? txn.date.split("T")[0]
                                    : "",
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
                                key: "recipient",
                                label: t("txPage.field.recipient"),
                                value:
                                    txn.recipient !== t("txPage.field.unknown")
                                        ? txn.recipient
                                        : undefined,
                            },
                            {
                                key: "category",
                                label: t("txPage.field.category"),
                                value:
                                    txn.category !==
                                    t("txPage.field.uncategorized")
                                        ? txn.category
                                        : undefined,
                            },
                            {
                                key: "amount",
                                label: t("txPage.field.amount"),
                                value: (
                                    <Money
                                        amount={txn.amount}
                                        currency={txn.currency}
                                        signed
                                    />
                                ),
                                editable: true,
                                editField: "amount",
                                editValue: String(txn.amount),
                                editType: "number",
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
                                // Read-only: balance is bank-stamped import data (ADR-094),
                                // never user-editable. Shown for imported rows only.
                                key: "balance",
                                label: t("txPage.field.balance"),
                                value:
                                    txn.balance != null ? (
                                        <Money
                                            amount={txn.balance}
                                            currency={txn.currency}
                                        />
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
                            },
                            {
                                key: "status",
                                label: t("txPage.field.status"),
                                value: txn.is_active
                                    ? t("txPage.statusActive")
                                    : t("txPage.statusInactive"),
                            },
                        ];
                        return (
                            <div className="divide-y divide-border">
                                {fields.map(
                                    ({
                                        key,
                                        label,
                                        value,
                                        editable,
                                        editField,
                                        editValue,
                                        editType,
                                    }) =>
                                        value ? (
                                            <div
                                                key={key}
                                                className="flex justify-between gap-4 py-2.5 first:pt-0 last:pb-0"
                                            >
                                                <label
                                                    htmlFor={
                                                        editable && editField
                                                            ? `transaction-info-${editField}`
                                                            : undefined
                                                    }
                                                    className="text-sm text-muted-foreground shrink-0"
                                                >
                                                    {label}
                                                </label>
                                                {editable &&
                                                editField &&
                                                editingInfoField ===
                                                    editField ? (
                                                    <form
                                                        className="flex items-center gap-1.5 min-w-0"
                                                        onSubmit={(event) => {
                                                            event.preventDefault();
                                                            void saveInfoFieldEdit();
                                                        }}
                                                    >
                                                        {editType === "date" ? (
                                                            <DatePicker
                                                                id={`transaction-info-${editField}`}
                                                                value={
                                                                    editingInfoValue
                                                                        ? parseLocalDateFromYmd(
                                                                              editingInfoValue,
                                                                          )
                                                                        : undefined
                                                                }
                                                                onChange={(d) =>
                                                                    setEditingInfoValue(
                                                                        d
                                                                            ? toYmd(
                                                                                  d,
                                                                              )
                                                                            : "",
                                                                    )
                                                                }
                                                                buttonClassName="h-8 w-40 text-sm"
                                                            />
                                                        ) : (
                                                            <>
                                                                <Input
                                                                    id={`transaction-info-${editField}`}
                                                                    type={
                                                                        editType ??
                                                                        "text"
                                                                    }
                                                                    value={
                                                                        editingInfoValue
                                                                    }
                                                                    onChange={(
                                                                        e,
                                                                    ) =>
                                                                        setEditingInfoValue(
                                                                            e
                                                                                .target
                                                                                .value,
                                                                        )
                                                                    }
                                                                    className="h-8 w-40"
                                                                    list={
                                                                        editField ===
                                                                        "bank"
                                                                            ? "account-name-suggestions"
                                                                            : undefined
                                                                    }
                                                                />
                                                                {editField ===
                                                                    "bank" && (
                                                                    <datalist id="account-name-suggestions">
                                                                        {(
                                                                            accountsData?.items ??
                                                                            []
                                                                        ).map(
                                                                            (
                                                                                a,
                                                                            ) => (
                                                                                <option
                                                                                    key={
                                                                                        a.id
                                                                                    }
                                                                                    value={
                                                                                        a.name
                                                                                    }
                                                                                >
                                                                                    {a.display_name ||
                                                                                        a.name}
                                                                                </option>
                                                                            ),
                                                                        )}
                                                                    </datalist>
                                                                )}
                                                            </>
                                                        )}
                                                        <Button
                                                            type="submit"
                                                            aria-label={t(
                                                                "common.save",
                                                            )}
                                                            variant="ghost"
                                                            size="icon"
                                                            className="icon-touch-target"
                                                            disabled={
                                                                updateMutation.isPending
                                                            }
                                                            title={t(
                                                                "common.save",
                                                            )}
                                                        >
                                                            <Check className="h-3.5 w-3.5" />
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            className="icon-touch-target"
                                                            onClick={cancelEdit}
                                                            disabled={
                                                                updateMutation.isPending
                                                            }
                                                            title={t(
                                                                "common.cancel",
                                                            )}
                                                        >
                                                            <X className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </form>
                                                ) : (
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-sm font-medium text-right break-all">
                                                            {value}
                                                        </span>
                                                        {editable &&
                                                        editField ? (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="icon-touch-target text-muted-foreground hover:text-foreground"
                                                                onClick={() =>
                                                                    startInfoFieldEdit(
                                                                        editField,
                                                                        editValue ??
                                                                            "",
                                                                    )
                                                                }
                                                                title={t(
                                                                    "common.edit",
                                                                )}
                                                            >
                                                                <Pencil className="h-3.5 w-3.5" />
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                )}
                                            </div>
                                        ) : null,
                                )}
                                <div className="py-2.5">
                                    <span className="text-sm text-muted-foreground">
                                        {t("txPage.field.tags")}
                                    </span>
                                    <TagInput
                                        value={tagSlugs}
                                        onChange={async (slugs) => {
                                            const previous = tagSlugs;
                                            setTagSlugs(slugs);
                                            try {
                                                await updateMutation.mutateAsync(
                                                    {
                                                        id: txn.id,
                                                        data: { tags: slugs },
                                                    },
                                                );
                                            } catch {
                                                setTagSlugs(previous);
                                            }
                                        }}
                                        disabled={updateMutation.isPending}
                                        className="mt-1.5"
                                    />
                                </div>
                                <div className="pt-3">
                                    <AttachmentPanel transactionId={txn.id} />
                                </div>
                            </div>
                        );
                    })()}
            </DialogContent>
        </Dialog>
    );
}
