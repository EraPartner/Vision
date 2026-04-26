import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Info, Pencil, Check, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useUpdateTransaction } from "@/hooks/useTransactions";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { formatDateStringWithAppSettings, parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { DatePicker } from "@/components/shared/DatePicker";
import { AttachmentPanel } from "@/components/shared/AttachmentPanel";
import type { TransactionUpdate } from "@/types/api";
import type { TableTransaction, InfoEditableField } from "../types";

interface TransactionInfoDialogProps {
    infoTransaction: TableTransaction | null;
    onClose: () => void;
    onApplyLocal: (transactionId: number, field: InfoEditableField, value: string | number | undefined) => void;
}

export function TransactionInfoDialog({
    infoTransaction,
    onClose,
    onApplyLocal,
}: TransactionInfoDialogProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const updateMutation = useUpdateTransaction();

    const [editingInfoField, setEditingInfoField] = useState<InfoEditableField | null>(null);
    const [editingInfoValue, setEditingInfoValue] = useState("");

    const startInfoFieldEdit = (field: InfoEditableField, currentValue: string) => {
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

        if (editingInfoField === 'amount') {
            const parsed = Number(trimmed);
            if (Number.isNaN(parsed)) return;
            payload.amount = parsed;
            localValue = parsed;
        } else if (editingInfoField === 'balance') {
            if (trimmed.length === 0) {
                payload.balance = undefined;
                localValue = undefined;
            } else {
                const parsed = Number(trimmed);
                if (Number.isNaN(parsed)) return;
                payload.balance = parsed;
                localValue = parsed;
            }
        } else if (editingInfoField === 'date') {
            if (!trimmed) return;
            payload.transaction_date = trimmed;
        } else if (editingInfoField === 'memo') {
            payload.memo = trimmed || undefined;
            localValue = trimmed || '';
        } else if (editingInfoField === 'currency') {
            payload.currency = trimmed || undefined;
        } else if (editingInfoField === 'bank') {
            payload.bank_account = trimmed || undefined;
        } else if (editingInfoField === 'comment') {
            payload.comment = trimmed || undefined;
            localValue = trimmed || '';
        }

        await updateMutation.mutateAsync({ id: infoTransaction.id, data: payload });
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
                        {t('txPage.detailsTitle')}
                    </DialogTitle>
                    <DialogDescription className="sr-only">{t('txPage.detailsTitle')}</DialogDescription>
                </DialogHeader>
                {infoTransaction && (() => {
                    const txn = infoTransaction;
                    const fields: Array<{
                        key: string;
                        label: string;
                        value?: string;
                        editable?: boolean;
                        editField?: InfoEditableField;
                        editValue?: string;
                        editType?: 'text' | 'number' | 'date';
                    }> = [
                            { key: 'id', label: t('txPage.field.id'), value: String(txn.id) },
                            {
                                key: 'date',
                                label: t('txPage.field.date'),
                                value: txn.date ? formatDateStringWithAppSettings(txn.date, appSettings.dateFormat) : '—',
                                editable: true,
                                editField: 'date',
                                editValue: txn.date ? txn.date.split('T')[0] : '',
                                editType: 'date',
                            },
                            {
                                key: 'description',
                                label: t('txPage.field.description'),
                                value: txn.memo || undefined,
                                editable: true,
                                editField: 'memo',
                                editValue: txn.memo || '',
                                editType: 'text',
                            },
                            { key: 'recipient', label: t('txPage.field.recipient'), value: txn.recipient !== t('txPage.field.unknown') ? txn.recipient : undefined },
                            { key: 'category', label: t('txPage.field.category'), value: txn.category !== t('txPage.field.uncategorized') ? txn.category : undefined },
                            {
                                key: 'amount',
                                label: t('txPage.field.amount'),
                                value: `${txn.amount >= 0 ? '+' : '-'}${formatCurrency(Math.abs(txn.amount), txn.currency, locale)}`,
                                editable: true,
                                editField: 'amount',
                                editValue: String(txn.amount),
                                editType: 'number',
                            },
                            {
                                key: 'currency',
                                label: t('txPage.field.currency'),
                                value: txn.currency,
                                editable: true,
                                editField: 'currency',
                                editValue: txn.currency || '',
                                editType: 'text',
                            },
                            {
                                key: 'bankAccount',
                                label: t('txPage.field.bankAccount'),
                                value: txn.bank,
                                editable: true,
                                editField: 'bank',
                                editValue: txn.bank || '',
                                editType: 'text',
                            },
                            {
                                key: 'balance',
                                label: t('txPage.field.balance'),
                                value: txn.balance != null ? formatCurrency(txn.balance, txn.currency, locale) : undefined,
                                editable: true,
                                editField: 'balance',
                                editValue: txn.balance != null ? String(txn.balance) : '',
                                editType: 'number',
                            },
                            {
                                key: 'comment',
                                label: t('txPage.field.comment'),
                                value: txn.comment || undefined,
                                editable: true,
                                editField: 'comment',
                                editValue: txn.comment || '',
                                editType: 'text',
                            },
                            { key: 'status', label: t('txPage.field.status'), value: txn.is_active ? t('txPage.statusActive') : t('txPage.statusInactive') },
                        ];
                    return (
                        <div className="divide-y divide-border">
                            {fields.map(({ key, label, value, editable, editField, editValue, editType }) => (
                                value ? (
                                    <div key={key} className="flex justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                                        <span className="text-sm text-muted-foreground shrink-0">{label}</span>
                                        {editable && editField && editingInfoField === editField ? (
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                {editType === 'date' ? (
                                                    <DatePicker
                                                        value={editingInfoValue ? parseLocalDateFromYmd(editingInfoValue) : undefined}
                                                        onChange={(d) => setEditingInfoValue(d ? toYmd(d) : '')}
                                                        buttonClassName="h-8 w-40 text-sm"
                                                    />
                                                ) : (
                                                    <Input
                                                        type={editType ?? 'text'}
                                                        value={editingInfoValue}
                                                        onChange={(e) => setEditingInfoValue(e.target.value)}
                                                        className="h-8 w-40"
                                                    />
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="icon-touch-target"
                                                    onClick={() => { void saveInfoFieldEdit(); }}
                                                    disabled={updateMutation.isPending}
                                                    title={t('common.save')}
                                                >
                                                    <Check className="h-3.5 w-3.5" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="icon-touch-target"
                                                    onClick={cancelEdit}
                                                    disabled={updateMutation.isPending}
                                                    title={t('common.cancel')}
                                                >
                                                    <X className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1">
                                                <span className="text-sm font-medium text-right break-all">{value}</span>
                                                {editable && editField ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="icon-touch-target text-muted-foreground hover:text-foreground"
                                                        onClick={() => startInfoFieldEdit(editField, editValue ?? '')}
                                                        title={t('common.edit')}
                                                    >
                                                        <Pencil className="h-3.5 w-3.5" />
                                                    </Button>
                                                ) : null}
                                            </div>
                                        )}
                                    </div>
                                ) : null
                            ))}
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
