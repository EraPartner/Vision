import {useState} from "react";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from "@/components/ui/command";
import {Badge} from "@/components/ui/badge";
import {Check, X, Link2} from "lucide-react";
import {cn} from "@/lib/utils";
import {useMergeRecipients} from "@/hooks/useRecipients";
import type {Recipient} from "@/types/api";

interface MergeRecipientsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    recipients: Recipient[];
}

export function MergeRecipientsDialog({open, onOpenChange, recipients}: MergeRecipientsDialogProps) {
    const [primaryId, setPrimaryId] = useState<number | null>(null);
    const [aliasIds, setAliasIds] = useState<number[]>([]);
    const mergeMutation = useMergeRecipients();

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

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
            <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Link2 className="h-5 w-5" />
                        Merge Recipients
                    </DialogTitle>
                    <DialogDescription>
                        Select a primary recipient, then choose aliases to merge into it. 
                        Transactions from aliases will display the primary recipient's name.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 flex-1 overflow-hidden">
                    {/* Step 1: Select primary */}
                    <div>
                        <label className="text-sm font-medium text-foreground mb-1 block">
                            1. Primary Recipient
                        </label>
                        {primary ? (
                            <div className="flex items-center gap-2 p-2 rounded-md border border-border bg-muted/50">
                                <Badge variant="default" className="gap-1">
                                    <Check className="h-3 w-3" />
                                    {primary.name}
                                </Badge>
                                <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={() => { setPrimaryId(null); setAliasIds([]); }}>
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ) : (
                            <Command className="border border-border rounded-md">
                                <CommandInput placeholder="Search for primary recipient…" />
                                <CommandList className="max-h-32">
                                    <CommandEmpty>No recipients found.</CommandEmpty>
                                    <CommandGroup>
                                        {availableRecipients.map(r => (
                                            <CommandItem key={r.id} value={r.name} onSelect={() => setPrimaryId(r.id)}>
                                                {r.name}
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                        )}
                    </div>

                    {/* Step 2: Select aliases */}
                    {primaryId && (
                        <div>
                            <label className="text-sm font-medium text-foreground mb-1 block">
                                2. Select Aliases ({aliasIds.length} selected)
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
                                <CommandInput placeholder="Search for aliases…" />
                                <CommandList className="max-h-40">
                                    <CommandEmpty>No recipients found.</CommandEmpty>
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
                                                            (alias of {r.primary_recipient_name})
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
                        Cancel
                    </Button>
                    <Button
                        onClick={handleMerge}
                        disabled={!primaryId || aliasIds.length === 0 || mergeMutation.isPending}
                    >
                        {mergeMutation.isPending ? "Merging…" : `Merge ${aliasIds.length} recipient(s)`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
