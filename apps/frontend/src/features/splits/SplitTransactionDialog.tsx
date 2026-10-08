import { useState, type ReactElement } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useCreateSplits, useSplitsByTransaction } from "@/hooks/useSplits";
import { Plus, Trash2, Users } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { parseDecimal } from "@/lib/decimal";
import {
    toDecimal,
    addAll,
    multiply,
    roundMoney,
} from "@vision/shared-utils/money";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { allocateEvenly } from "./splitShares";

type SplitType = "equal" | "full" | "custom";

interface SplitEntry {
    uid: string;
    recipient_id: number | null;
    amount: string;
    note: string;
}

interface SplitTransactionDialogProps {
    triggerLabel?: string;
    /** Replaces the default icon button; rendered through DialogTrigger asChild. */
    trigger?: ReactElement;
    transactionId: number;
    transactionAmount: number;
    transactionCurrency: string;
}

export function SplitTransactionDialog({
    triggerLabel,
    trigger,
    transactionId,
    transactionAmount,
    transactionCurrency,
}: SplitTransactionDialogProps) {
    const [open, setOpen] = useState(false);
    const [splitType, setSplitType] = useState<SplitType>("equal");
    const [entries, setEntries] = useState<SplitEntry[]>([
        { uid: crypto.randomUUID(), recipient_id: null, amount: "", note: "" },
    ]);
    const [portalContainer, setPortalContainer] =
        useState<HTMLDivElement | null>(null);
    const createSplits = useCreateSplits();
    const { data: existingSplitsData, isLoading: isLoadingExistingSplits } =
        useSplitsByTransaction(open ? transactionId : null);
    const { t, tc } = useLanguage();
    const { appSettings } = useAppSettings();
    const formatCurrency = useCurrencyFormatter(transactionCurrency);

    const absAmount = Math.abs(transactionAmount);

    const addEntry = () =>
        setEntries((prev) => [
            ...prev,
            {
                uid: crypto.randomUUID(),
                recipient_id: null,
                amount: "",
                note: "",
            },
        ]);

    const removeEntry = (idx: number) =>
        setEntries((prev) => prev.filter((_, i) => i !== idx));

    const updateEntry = (
        idx: number,
        field: keyof SplitEntry,
        value: number | string | null,
    ) => {
        setEntries((prev) =>
            prev.map((e, i) => (i === idx ? { ...e, [field]: value } : e)),
        );
    };

    const validEntries = entries.filter((e) => e.recipient_id != null);
    const totalPeople = validEntries.length + 1; // +1 for "me"

    // Money math runs through Decimal and rounds to cents on emit so the
    // "exceeds total" gate compares exact cent values — a float `reduce`
    // could drift an exact split just past `absAmount` and mis-gate it.
    // All of these values are only consumed inside <DialogContent> (rendered
    // only when open), so a closed dialog — one sits in every table row — must
    // not run the Decimal pipeline on every parent re-render/keystroke.
    const equalShare =
        open && totalPeople > 1
            ? roundMoney(toDecimal(absAmount).div(totalPeople))
            : 0;

    // "Others pay all" (0/100): the others cover the whole amount between
    // them, cent-exact, so one person owes exactly the transaction and three
    // people owe shares that add up to it (no rounding gap either way).
    const fullShares =
        open && splitType === "full"
            ? allocateEvenly(absAmount, validEntries.length)
            : [];

    const customTotal = open
        ? roundMoney(
              addAll(
                  validEntries.map((e) =>
                      parseDecimal(e.amount, appSettings.numberFormat),
                  ),
              ),
          )
        : 0;
    const existingSplits = existingSplitsData?.items ?? [];
    const existingSplitTotal = open
        ? roundMoney(addAll(existingSplits.map((split) => split.amount || 0)))
        : 0;
    const existingRecipientNames = existingSplits
        .map((split) => split.recipient_name)
        .filter(Boolean)
        .join(", ");
    const newSplitTotal =
        splitType === "equal"
            ? roundMoney(multiply(equalShare, validEntries.length))
            : splitType === "full"
              ? roundMoney(addAll(fullShares))
              : customTotal;
    const hasNonPositiveSplitAmount = !open
        ? false
        : splitType === "equal"
          ? validEntries.length > 0 && equalShare <= 0
          : splitType === "full"
            ? fullShares.some((share) => share <= 0)
            : validEntries.some((entry) => {
                if (!entry.recipient_id) return false;
                return (
                    parseDecimal(entry.amount, appSettings.numberFormat) <= 0
                );
            });
    const totalAfterSubmit = roundMoney(
        toDecimal(existingSplitTotal).plus(newSplitTotal),
    );
    const remainingSplitCapacity = open
        ? Math.max(
              roundMoney(toDecimal(absAmount).minus(existingSplitTotal)),
              0,
          )
        : 0;
    const hasExceededTransactionTotal = open
        ? toDecimal(totalAfterSubmit).gt(roundMoney(absAmount))
        : false;

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        const splits = validEntries.map((e, index) => ({
            recipient_id: e.recipient_id!,
            amount:
                splitType === "equal"
                    ? equalShare
                    : splitType === "full"
                      ? fullShares[index]
                      : parseDecimal(e.amount, appSettings.numberFormat),
            note: e.note || undefined,
        }));

        if (splits.length === 0) return;

        createSplits.mutate(
            { transaction_id: transactionId, splits },
            {
                onSuccess: () => {
                    setOpen(false);
                    setEntries([
                        {
                            uid: crypto.randomUUID(),
                            recipient_id: null,
                            amount: "",
                            note: "",
                        },
                    ]);
                },
            },
        );
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {trigger ? (
                <DialogTrigger asChild>{trigger}</DialogTrigger>
            ) : (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <DialogTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="icon-touch-target text-label-secondary hover:text-primary"
                                aria-label={
                                    triggerLabel ?? t("splitDialog.buttonTitle")
                                }
                            >
                                <Users aria-hidden />
                            </Button>
                        </DialogTrigger>
                    </TooltipTrigger>
                    <TooltipContent>
                        {triggerLabel ?? t("splitDialog.buttonTitle")}
                    </TooltipContent>
                </Tooltip>
            )}
            <DialogContent className="sm:max-w-lg">
                {/* Portal target: dropdowns render here (inside dialog DOM) so the dialog focus trap covers them */}
                <div ref={setPortalContainer} />
                <DialogHeader>
                    <DialogTitle>{t("splitDialog.buttonTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("splitDialog.total", {
                            amount: formatCurrency(absAmount, {
                                currency: transactionCurrency,
                            }),
                        })}
                    </DialogDescription>
                </DialogHeader>

                {/* Real <form> so Enter in any entry field submits; grid gap-5
                    mirrors DialogContent's layout, so this wrapper is layout-neutral. */}
                <form onSubmit={handleSubmit} className="grid gap-5">
                    <div className="space-y-4">
                        {!isLoadingExistingSplits && (
                            <Alert className="py-3">
                                <AlertDescription>
                                    {existingSplits.length > 0
                                        ? tc(
                                              "splitDialog.alreadySplit",
                                              existingSplits.length,
                                          )
                                        : t("splitDialog.notSplitYet")}
                                    {existingRecipientNames && (
                                        <span className="mt-1 block type-footnote text-label-secondary">
                                            {t(
                                                "splitDialog.existingRecipients",
                                                {
                                                    recipients:
                                                        existingRecipientNames,
                                                },
                                            )}
                                        </span>
                                    )}
                                    {existingSplits.length > 0 && (
                                        <ul className="mt-2 space-y-1 type-footnote text-label-secondary">
                                            {existingSplits.map((split) => (
                                                <li key={split.id}>
                                                    {t(
                                                        "splitDialog.existingSplitLine",
                                                        {
                                                            recipient:
                                                                split.recipient_name ||
                                                                t(
                                                                    "txPage.field.unknown",
                                                                ),
                                                            amount: formatCurrency(
                                                                split.amount,
                                                                {
                                                                    currency:
                                                                        transactionCurrency,
                                                                },
                                                            ),
                                                        },
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </AlertDescription>
                            </Alert>
                        )}

                        {!isLoadingExistingSplits &&
                            hasExceededTransactionTotal && (
                                <Alert variant="destructive" className="py-3">
                                    <AlertDescription>
                                        {t("splitDialog.exceedsTotal", {
                                            remaining: formatCurrency(
                                                remainingSplitCapacity,
                                                {
                                                    currency:
                                                        transactionCurrency,
                                                },
                                            ),
                                        })}
                                    </AlertDescription>
                                </Alert>
                            )}

                        <SegmentedControl
                            value={splitType}
                            onValueChange={(value) => {
                                if (
                                    value === "equal" ||
                                    value === "full" ||
                                    value === "custom"
                                )
                                    setSplitType(value);
                            }}
                            aria-label={t("splitDialog.splitType")}
                        >
                            <SegmentedControlItem value="equal">
                                {t("splitDialog.equalSplit")}
                            </SegmentedControlItem>
                            <SegmentedControlItem value="full">
                                {t("splitDialog.othersPayAll")}
                            </SegmentedControlItem>
                            <SegmentedControlItem value="custom">
                                {t("splitDialog.customAmounts")}
                            </SegmentedControlItem>
                        </SegmentedControl>

                        {splitType === "equal" && validEntries.length > 0 && (
                            <p className="type-callout text-label-secondary">
                                {t("splitDialog.eachPays", {
                                    amount: formatCurrency(equalShare, {
                                        currency: transactionCurrency,
                                    }),
                                    n: totalPeople,
                                })}
                            </p>
                        )}

                        {splitType === "full" && validEntries.length > 0 && (
                            <p className="type-callout text-label-secondary">
                                {tc(
                                    "splitDialog.othersPayAllSummary",
                                    validEntries.length,
                                    {
                                        amount: formatCurrency(absAmount, {
                                            currency: transactionCurrency,
                                        }),
                                    },
                                )}
                            </p>
                        )}

                        <div className="max-h-[300px] space-y-3 overflow-y-auto">
                            {entries.map((entry, idx) => (
                                <Card key={entry.uid}>
                                    <CardContent
                                        variant="compact"
                                        className="flex items-start gap-2"
                                    >
                                        <div className="flex-1 space-y-2">
                                            <RecipientCombobox
                                                aria-label={`${t("recipientsPage.col.recipient")} ${idx + 1}`}
                                                value={entry.recipient_id}
                                                onSelect={(id) =>
                                                    updateEntry(
                                                        idx,
                                                        "recipient_id",
                                                        id,
                                                    )
                                                }
                                                className="w-full"
                                                portalContainer={
                                                    portalContainer
                                                }
                                            />
                                            {splitType === "full" &&
                                                entry.recipient_id != null && (
                                                    <p className="type-footnote text-label-secondary">
                                                        {t("splitDialog.owes", {
                                                            amount: formatCurrency(
                                                                fullShares[
                                                                    validEntries.indexOf(
                                                                        entry,
                                                                    )
                                                                ] ?? 0,
                                                                {
                                                                    currency:
                                                                        transactionCurrency,
                                                                },
                                                            ),
                                                        })}
                                                    </p>
                                                )}
                                            {splitType === "custom" && (
                                                <Input
                                                    aria-label={`${t("splitDialog.amountOwed")} ${idx + 1}`}
                                                    type="text"
                                                    inputMode="decimal"
                                                    placeholder={t(
                                                        "splitDialog.amountOwed",
                                                    )}
                                                    value={entry.amount}
                                                    onChange={(e) =>
                                                        updateEntry(
                                                            idx,
                                                            "amount",
                                                            e.target.value,
                                                        )
                                                    }
                                                />
                                            )}
                                            <Input
                                                aria-label={`${t("splitDialog.noteOptional")} ${idx + 1}`}
                                                placeholder={t(
                                                    "splitDialog.noteOptional",
                                                )}
                                                value={entry.note}
                                                onChange={(e) =>
                                                    updateEntry(
                                                        idx,
                                                        "note",
                                                        e.target.value,
                                                    )
                                                }
                                            />
                                        </div>
                                        {entries.length > 1 && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="shrink-0 text-label-secondary hover:text-destructive"
                                                aria-label={t(
                                                    "aria.removeEntry",
                                                )}
                                                onClick={() => removeEntry(idx)}
                                            >
                                                <Trash2 aria-hidden />
                                            </Button>
                                        )}
                                    </CardContent>
                                </Card>
                            ))}
                        </div>

                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addEntry}
                        >
                            <Plus aria-hidden />
                            {t("splitDialog.addPerson")}
                        </Button>

                        {splitType === "custom" && validEntries.length > 0 && (
                            <p className="type-callout text-label-secondary">
                                {t("splitDialog.othersOwe", {
                                    x: formatCurrency(customTotal, {
                                        currency: transactionCurrency,
                                    }),
                                    total: formatCurrency(absAmount, {
                                        currency: transactionCurrency,
                                    }),
                                })}
                            </p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                validEntries.length === 0 ||
                                hasNonPositiveSplitAmount ||
                                hasExceededTransactionTotal ||
                                createSplits.isPending
                            }
                        >
                            {createSplits.isPending
                                ? t("splitDialog.splitting")
                                : t("splitDialog.split")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
