import { useEffect, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import {
    useAccountMergePreview,
    useAccounts,
    useMergeAccounts,
} from "@/hooks/useAccounts";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { numberFormatToLocale } from "@/utils/currency";
import type { Account } from "@/types/api";

const label = (a: Account) => a.display_name || a.name;

/**
 * Merge `source` into another (survivor) account chosen by the user. The source's
 * transactions, planned transactions, holdings, and funding references move to the
 * survivor, and the source is deleted (ADR-088). Irreversible.
 *
 * Candidates come from the FULL population (`active: 'all'`, archived labeled) —
 * independent of any hub filter (§3 F9). Once a survivor is chosen, the WP-A3
 * read-only preview endpoint feeds "{n} transactions + {m} planned will move;
 * resulting balance X" plus the interleaved-stamp warning.
 */
export function MergeAccountDialog({
    source,
    open,
    onOpenChange,
}: {
    source: Account;
    open: boolean;
    onOpenChange: (o: boolean) => void;
}) {
    const { t } = useLanguage();
    const fmtCur = useCurrencyFormatter();
    const { appSettings } = useAppSettings();
    const merge = useMergeAccounts();
    const [targetId, setTargetId] = useState<string>("");
    const [acknowledgedPair, setAcknowledgedPair] = useState<string | null>(
        null,
    );
    useEffect(() => {
        setAcknowledgedPair(null);
    }, [source.id, open]);
    const pairKey = `${source.id}:${targetId}`;
    const acknowledged = acknowledgedPair === pairKey;

    // Full population, archived included — the dialog must offer every possible
    // survivor regardless of what the hub currently displays.
    const { data } = useAccounts({ active: "all" });
    const candidates = (data?.items ?? []).filter((a) => a.id !== source.id);
    const target = candidates.find((c) => String(c.id) === targetId);

    // Read-only dry-run of this exact source→survivor pair (WP-A3 endpoint).
    const preview = useAccountMergePreview(source.id, target?.id);

    const previewReady =
        !preview.isFetching &&
        !preview.isError &&
        preview.data?.source === source.id &&
        preview.data?.into === target?.id;

    // Counts use the SAME locale the money formatter derives from the
    // number-format setting, so "1.002 transactions" and "€ 1.002,00" agree.
    const numFmt = new Intl.NumberFormat(
        numberFormatToLocale(appSettings.numberFormat),
    );

    const reset = () => {
        setTargetId("");
        setAcknowledgedPair(null);
    };

    const handleMerge = () => {
        if (!targetId || !acknowledged || !previewReady || merge.isPending)
            return;
        merge.mutate(
            { targetId: Number(targetId), sourceIds: [source.id] },
            {
                onSuccess: () => {
                    reset();
                    onOpenChange(false);
                },
            },
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("accounts.mergeTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("accounts.mergeDescription", {
                            source: label(source),
                        })}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="merge-target">
                            {t("accounts.mergeTargetLabel")}
                        </Label>
                        <Select
                            value={targetId}
                            onValueChange={(value) => {
                                setTargetId(value);
                                setAcknowledgedPair(null);
                            }}
                        >
                            <SelectTrigger id="merge-target">
                                <SelectValue
                                    placeholder={t(
                                        "accounts.mergeTargetPlaceholder",
                                    )}
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {candidates.map((a) => (
                                    <SelectItem key={a.id} value={String(a.id)}>
                                        {label(a)}
                                        {!a.is_active
                                            ? ` (${t("accounts.archived")})`
                                            : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {/* What-would-move preview (§3 F9) */}
                    {target && (
                        <Card>
                            <CardContent
                                variant="compact"
                                className="type-body"
                            >
                                {preview.isError ? (
                                    <div role="alert" className="space-y-2">
                                        <p className="text-destructive">
                                            {t("accounts.mergePreview.failed")}
                                        </p>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={preview.isFetching}
                                            onClick={() => {
                                                setAcknowledgedPair(null);
                                                void preview.refetch();
                                            }}
                                        >
                                            {t("common.retry")}
                                        </Button>
                                    </div>
                                ) : !preview.data ? (
                                    <span className="flex items-center gap-2 text-label-secondary">
                                        <Loader2
                                            className="h-3.5 w-3.5 animate-spin"
                                            aria-hidden
                                        />
                                        {t("accounts.mergePreview.loading")}
                                    </span>
                                ) : (
                                    <>
                                        <p>
                                            {t(
                                                "accounts.mergePreview.summary",
                                                {
                                                    transactions: numFmt.format(
                                                        preview.data.reassigned
                                                            .transactions,
                                                    ),
                                                    planned: numFmt.format(
                                                        preview.data.reassigned
                                                            .planned,
                                                    ),
                                                    balance: fmtCur(
                                                        preview.data
                                                            .projectedBalance,
                                                        {
                                                            currency:
                                                                preview.data
                                                                    .projectedBalanceCurrency ||
                                                                target.currency,
                                                        },
                                                    ),
                                                },
                                            )}
                                        </p>
                                        {preview.data
                                            .projectedBalanceIncomplete && (
                                            <div className="mt-2 type-footnote text-warning">
                                                <p>
                                                    {t(
                                                        "accounts.mergePreview.incomplete",
                                                    )}
                                                </p>
                                                {preview.data.balanceParts
                                                    .filter((part) =>
                                                        preview.data.unconvertedCurrencies.includes(
                                                            part.currency,
                                                        ),
                                                    )
                                                    .map((part) => (
                                                        <p key={part.currency}>
                                                            {fmtCur(
                                                                part.balance,
                                                                {
                                                                    currency:
                                                                        part.currency,
                                                                },
                                                            )}{" "}
                                                            {t(
                                                                "accounts.balanceExcluded",
                                                            )}
                                                        </p>
                                                    ))}
                                            </div>
                                        )}
                                        {preview.data.stampsInterleaved && (
                                            <p className="mt-2 flex items-start gap-1.5 type-footnote text-warning">
                                                <AlertTriangle
                                                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                                    aria-hidden
                                                />
                                                {t(
                                                    "accounts.mergePreview.interleaved",
                                                )}
                                            </p>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    )}
                    {/* Irreversibility is always called out, not only once a target is picked. */}
                    <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" aria-hidden />
                        <AlertDescription>
                            {target
                                ? t("accounts.mergeWarning", {
                                      source: label(source),
                                      target: label(target),
                                  })
                                : t("accounts.mergeIrreversible")}
                        </AlertDescription>
                    </Alert>
                    {target && target.type !== source.type && (
                        <p className="type-callout text-warning">
                            {t("accounts.mergeTypeMismatch", {
                                sourceType: t(`accounts.type.${source.type}`),
                                targetType: t(`accounts.type.${target.type}`),
                            })}
                        </p>
                    )}
                    <div className="flex items-start gap-2">
                        <Checkbox
                            id="merge-account-acknowledge"
                            checked={acknowledged}
                            disabled={!previewReady || merge.isPending}
                            onCheckedChange={(c) =>
                                setAcknowledgedPair(c === true ? pairKey : null)
                            }
                            className="mt-0.5"
                        />
                        <Label
                            htmlFor="merge-account-acknowledge"
                            className="cursor-pointer font-normal leading-snug"
                        >
                            {t("accounts.mergeAcknowledge")}
                        </Label>
                    </div>
                </div>
                <DialogFooter className="pt-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={
                            !targetId ||
                            !acknowledged ||
                            !previewReady ||
                            merge.isPending
                        }
                        onClick={handleMerge}
                    >
                        {merge.isPending && (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        {t("accounts.mergeConfirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
