import { useId, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { badgeVariants } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    useAllRecipientsForMerge,
    useMergeRecipients,
} from "@/hooks/useRecipients";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";

interface MergeRecipientsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function MergeRecipientsDialog({
    open,
    onOpenChange,
}: MergeRecipientsDialogProps) {
    const { t, tc } = useLanguage();
    const primarySearchId = useId();
    const aliasSearchId = useId();
    const [primaryId, setPrimaryId] = useState<number | null>(null);
    const [aliasIds, setAliasIds] = useState<number[]>([]);
    useUnsavedChanges(primaryId !== null || aliasIds.length > 0);
    const mergeMutation = useMergeRecipients();

    const {
        data: recipients = [],
        isLoading: recipientsLoading,
        isError: recipientsError,
        refetch,
        isFetching,
    } = useAllRecipientsForMerge(open);

    // Only show recipients that are NOT already aliases of someone else
    const availableRecipients = recipients.filter(
        (r) => !r.primary_recipient_id,
    );
    const primary = availableRecipients.find((r) => r.id === primaryId);

    const toggleAlias = (id: number) => {
        if (id === primaryId) return;
        setAliasIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    };

    const handleMerge = () => {
        if (
            !primaryId ||
            aliasIds.length === 0 ||
            recipientsError ||
            recipientsLoading ||
            mergeMutation.isPending
        )
            return;
        mergeMutation.mutate(
            { primaryId, aliasIds },
            {
                onSuccess: () => {
                    setPrimaryId(null);
                    setAliasIds([]);
                    onOpenChange(false);
                },
            },
        );
    };

    const reset = () => {
        setPrimaryId(null);
        setAliasIds([]);
    };

    // No reset on dismissal: Radix reports an overlay click and Escape through
    // the same callback as a deliberate close, so resetting there threw away a
    // painstakingly assembled alias list on one stray click. The dialog stays
    // mounted while closed, so the selection is still there on reopen; reset()
    // belongs to Cancel and to a merge that succeeded.
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>{t("merge.title")}</DialogTitle>
                    <DialogDescription>
                        {t("merge.description")}
                    </DialogDescription>
                </DialogHeader>

                {recipientsError && (
                    <Alert variant="destructive">
                        <AlertDescription className="flex flex-wrap items-center gap-3">
                            <span>{t("merge.loadFailed")}</span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={isFetching}
                                onClick={() => void refetch()}
                            >
                                {t("common.retry")}
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}
                <div className="space-y-4 flex-1 overflow-hidden">
                    {/* Step 1: Select primary */}
                    <div className="space-y-2">
                        <Label htmlFor={primarySearchId}>
                            {t("merge.primaryRecipient")}
                        </Label>
                        {recipientsLoading && (
                            <Skeleton
                                className="h-10 w-full"
                                aria-label={t("common.loading")}
                            />
                        )}
                        {primary ? (
                            <List>
                                <ListRow
                                    leading={
                                        <Check
                                            className="h-4 w-4 text-gain"
                                            aria-hidden
                                        />
                                    }
                                    title={primary.name}
                                    trailing={
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 text-label-secondary"
                                            aria-label={t(
                                                "aria.clearSelection",
                                            )}
                                            onClick={() => {
                                                setPrimaryId(null);
                                                setAliasIds([]);
                                            }}
                                        >
                                            <X aria-hidden />
                                        </Button>
                                    }
                                />
                            </List>
                        ) : !recipientsLoading && !recipientsError ? (
                            <Command className="rounded-card corner-continuous border border-border/60">
                                <CommandInput
                                    id={primarySearchId}
                                    placeholder={t("merge.searchPrimary")}
                                />
                                <CommandList className="max-h-32">
                                    <CommandEmpty>
                                        {t("merge.noResults")}
                                    </CommandEmpty>
                                    <CommandGroup>
                                        {availableRecipients.map((r) => (
                                            <CommandItem
                                                key={r.id}
                                                value={r.name}
                                                onSelect={() =>
                                                    setPrimaryId(r.id)
                                                }
                                            >
                                                {r.name}
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                        ) : null}
                    </div>

                    {/* Step 2: Select aliases */}
                    {primaryId && (
                        <div className="space-y-2">
                            <Label htmlFor={aliasSearchId}>
                                {t("merge.selectAliases", {
                                    n: String(aliasIds.length),
                                })}
                            </Label>

                            {aliasIds.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {aliasIds.map((id) => {
                                        const r = recipients.find(
                                            (x) => x.id === id,
                                        );
                                        return r ? (
                                            <button
                                                key={id}
                                                type="button"
                                                className={cn(
                                                    badgeVariants({
                                                        variant: "secondary",
                                                    }),
                                                    "gap-1 focus-ring",
                                                )}
                                                aria-label={t(
                                                    "merge.removeAlias",
                                                    { name: r.name },
                                                )}
                                                onClick={() => toggleAlias(id)}
                                            >
                                                {r.name}
                                                <X
                                                    className="h-3 w-3"
                                                    aria-hidden
                                                />
                                            </button>
                                        ) : null;
                                    })}
                                </div>
                            )}

                            <Command className="rounded-card corner-continuous border border-border/60">
                                <CommandInput
                                    id={aliasSearchId}
                                    placeholder={t("merge.searchAliases")}
                                />
                                <CommandList className="max-h-40">
                                    <CommandEmpty>
                                        {t("merge.noResults")}
                                    </CommandEmpty>
                                    <CommandGroup>
                                        {recipients
                                            .filter((r) => r.id !== primaryId)
                                            .map((r) => (
                                                <CommandItem
                                                    key={r.id}
                                                    value={r.name}
                                                    onSelect={() =>
                                                        toggleAlias(r.id)
                                                    }
                                                >
                                                    <Check
                                                        aria-hidden
                                                        className={cn(
                                                            "mr-2 h-4 w-4",
                                                            aliasIds.includes(
                                                                r.id,
                                                            )
                                                                ? "opacity-100"
                                                                : "opacity-0",
                                                        )}
                                                    />
                                                    <span
                                                        className={
                                                            r.primary_recipient_id
                                                                ? "text-label-secondary"
                                                                : ""
                                                        }
                                                    >
                                                        {r.name}
                                                    </span>
                                                    {r.primary_recipient_id && (
                                                        <span className="ml-2 type-footnote text-label-secondary">
                                                            {t(
                                                                "merge.aliasOf",
                                                                {
                                                                    name: r.primary_recipient_name!,
                                                                },
                                                            )}
                                                        </span>
                                                    )}
                                                </CommandItem>
                                            ))}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => {
                            reset();
                            onOpenChange(false);
                        }}
                    >
                        {t("merge.cancel")}
                    </Button>
                    <Button
                        onClick={handleMerge}
                        disabled={
                            !primaryId ||
                            aliasIds.length === 0 ||
                            mergeMutation.isPending ||
                            recipientsLoading ||
                            recipientsError
                        }
                    >
                        {mergeMutation.isPending
                            ? t("merge.merging")
                            : tc("merge.mergeCount", aliasIds.length)}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
