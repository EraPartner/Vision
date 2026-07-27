import {useState} from "react";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from "@/components/ui/command";
import {Badge} from "@/components/ui/badge";
import {Check, X, Link2, Loader2} from "lucide-react";
import {cn} from "@/lib/utils";
import {useMergeRecipients} from "@/hooks/useRecipients";
import {useLanguage} from "@/contexts/LanguageContext";
import {useQuery} from "@tanstack/react-query";
import {apiClient} from "@/lib/api";
import {recipientKeys} from "@/lib/queryKeys";
import type {Recipient} from "@/types/api";

interface MergeRecipientsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function MergeRecipientsDialog({open, onOpenChange}: MergeRecipientsDialogProps) {
    const { t } = useLanguage();
    const [primaryId, setPrimaryId] = useState<number | null>(null);
    const [aliasIds, setAliasIds] = useState<number[]>([]);
    const mergeMutation = useMergeRecipients();

    const { data: recipients = [], isLoading: recipientsLoading } = useQuery({
        queryKey: recipientKeys.mergeAll,
        enabled: open,
        staleTime: 2 * 60_000,
        queryFn: async () => {
            const pageSize = 1000;
            let offset = 0;
            let total: number;
            const all: Recipient[] = [];

            do {
                const response = await apiClient.getRecipients({
                    limit: pageSize,
                    offset,
                    active: false,
                    sort_by: "name",
                    sort_dir: "asc",
                });

                all.push(...response.items);
                total = response.total ?? all.length;
                offset += response.items.length;

                if (response.items.length === 0) break;
            } while (offset < total);

            return all;
        },
    });

    // Only show recipients that are NOT already aliases of someone else
    const availableRecipients = recipients.filter(r => !r.primary_recipient_id);
    const primary = availableRecipients.find(r => r.id === primaryId);

    const toggleAlias = (id: number) => {
        if (id === primaryId) return;
        setAliasIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    };

    const handleMerge = () => {
        if (!primaryId || aliasIds.length === 0) return;
        mergeMutation.mutate({primaryId, aliasIds}, {
            onSuccess: () => {
                setPrimaryId(null);
                setAliasIds([]);
                onOpenChange(false);
            },
        });
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
                    <DialogTitle className="flex items-center gap-2">
                        <Link2 className="h-5 w-5" />
                        {t('merge.title')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('merge.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 flex-1 overflow-hidden">
                    {/* Step 1: Select primary */}
                    <div>
                        <label className="text-sm font-medium text-foreground mb-1 block">
                            {t('merge.primaryRecipient')}
                        </label>
                        {recipientsLoading && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground p-2 border rounded-md">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {t('common.loading')}
                            </div>
                        )}
                        {primary ? (
                            <div className="flex items-center gap-2 p-2 rounded-md border border-border bg-muted/50">
                                <Badge variant="default" className="gap-1">
                                    <Check className="h-3 w-3" />
                                    {primary.name}
                                </Badge>
                                <Button variant="ghost" size="icon" className="icon-touch-target ml-auto [&_svg]:size-3" aria-label={t('aria.clearSelection')} onClick={() => { setPrimaryId(null); setAliasIds([]); }}>
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ) : !recipientsLoading ? (
                            <Command className="border border-border rounded-md">
                                <CommandInput placeholder={t('merge.searchPrimary')} />
                                <CommandList className="max-h-32">
                                    <CommandEmpty>{t('merge.noResults')}</CommandEmpty>
                                    <CommandGroup>
                                        {availableRecipients.map(r => (
                                            <CommandItem key={r.id} value={r.name} onSelect={() => setPrimaryId(r.id)}>
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
                        <div>
                            <label className="text-sm font-medium text-foreground mb-1 block">
                                {t('merge.selectAliases', { n: String(aliasIds.length) })}
                            </label>

                            {aliasIds.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                    {aliasIds.map(id => {
                                        const r = recipients.find(x => x.id === id);
                                        return r ? (
                                            <Badge key={id} variant="secondary" className="gap-1 cursor-pointer" onClick={() => toggleAlias(id)}>
                                                {r.name}
                                                <X className="h-3 w-3" />
                                            </Badge>
                                        ) : null;
                                    })}
                                </div>
                            )}

                            <Command className="border border-border rounded-md">
                                <CommandInput placeholder={t('merge.searchAliases')} />
                                <CommandList className="max-h-40">
                                    <CommandEmpty>{t('merge.noResults')}</CommandEmpty>
                                    <CommandGroup>
                                        {recipients
                                            .filter(r => r.id !== primaryId)
                                            .map(r => (
                                                <CommandItem
                                                    key={r.id}
                                                    value={r.name}
                                                    onSelect={() => toggleAlias(r.id)}
                                                >
                                                    <Check className={cn("mr-2 h-4 w-4", aliasIds.includes(r.id) ? "opacity-100" : "opacity-0")} />
                                                    <span className={r.primary_recipient_id ? "text-muted-foreground" : ""}>
                                                        {r.name}
                                                    </span>
                                                    {r.primary_recipient_id && (
                                                        <span className="ml-2 text-xs text-muted-foreground">
                                                            {t('merge.aliasOf', { name: r.primary_recipient_name! })}
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
                    <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>
                        {t('merge.cancel')}
                    </Button>
                    <Button
                        onClick={handleMerge}
                        disabled={!primaryId || aliasIds.length === 0 || mergeMutation.isPending || recipientsLoading}
                    >
                        {mergeMutation.isPending ? t('merge.merging') : t('merge.mergeCount', { n: String(aliasIds.length) })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
