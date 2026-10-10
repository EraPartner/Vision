import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { List, ListRow } from "@/components/ui/list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RowMenu } from "@/components/shared/RowMenu";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    AlertTriangle,
    Check,
    RefreshCw,
    ShieldCheck,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiClient } from "@/lib/api";
import type {
    MappingKeyType,
    MappingProposal,
    MappingSaveInput,
    ResearchAssetClass,
} from "@/types/research";
import {
    researchMappingsKey,
    useResearchMappingsQuery,
} from "./useResearchQueries";

interface ResearchMappingDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** ISIN (key_type=isin) or Vision-internal id (key_type=internal). */
    instrumentKey: string;
    keyType?: MappingKeyType;
    /** Search query used to auto-propose per-provider symbols. */
    query: string;
    assetClass?: ResearchAssetClass;
    displayName?: string;
    /**
     * When this mapping is for a held investment, its id — the holding's
     * already-configured provider is pre-seeded as a confirmed proposal.
     */
    investmentId?: number;
}

/** A proposal that was pre-seeded from the held investment is already known-good. */
function isFromHolding(p: MappingProposal): boolean {
    return p.fromHolding === true;
}

/** A proposal worth confirming carries a provider symbol (held providers are already confirmed). */
function isConfirmable(p: MappingProposal): boolean {
    return (
        !!p.providerSymbol &&
        !isFromHolding(p) &&
        (p.status === "auto" || p.status === "confirmed")
    );
}

function detailLine(
    ...parts: Array<string | null | undefined>
): string | undefined {
    const line = parts.filter(Boolean).join(" · ");
    return line || undefined;
}

export function ResearchMappingDialog({
    open,
    onOpenChange,
    instrumentKey,
    keyType = "isin",
    query,
    assetClass,
    displayName,
    investmentId,
}: ResearchMappingDialogProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<Record<string, boolean>>({});

    const mappingsKey = researchMappingsKey(instrumentKey, keyType);

    // Existing stored mappings.
    const { data: existingResult, isFetching: loadingExisting } =
        useResearchMappingsQuery(instrumentKey, keyType, open);
    const existing = existingResult?.data.items ?? [];

    // Resolve proposals (auto-propose per provider). Does not persist.
    const resolveMutation = useMutation({
        mutationFn: () =>
            apiClient.resolveResearchMappings({
                instrument_key: instrumentKey,
                key_type: keyType,
                asset_class: assetClass,
                query,
                ...(investmentId !== undefined
                    ? { investment_id: investmentId }
                    : {}),
            }),
    });
    const proposals = useMemo(
        () => resolveMutation.data?.data.proposals ?? [],
        [resolveMutation.data],
    );

    // Auto-resolve once when the dialog opens.
    useEffect(() => {
        if (
            open &&
            instrumentKey &&
            query &&
            !resolveMutation.data &&
            !resolveMutation.isPending
        ) {
            resolveMutation.mutate();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, instrumentKey, query, investmentId]);

    // Pre-select confirmable proposals not already stored.
    useEffect(() => {
        if (proposals.length === 0) return;
        const next: Record<string, boolean> = {};
        for (const p of proposals) {
            if (isConfirmable(p)) next[p.provider] = true;
        }
        setSelected(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resolveMutation.data]);

    const saveMutation = useMutation({
        mutationFn: (mappings: MappingSaveInput[]) =>
            apiClient.saveResearchMappings({
                instrument_key: instrumentKey,
                key_type: keyType,
                mappings,
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: mappingsKey });
            toast.success(t("research.mapping.saved"));
        },
        onError: () => toast.error(t("research.mapping.saveError")),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: number) => apiClient.deleteResearchMapping(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: mappingsKey });
            toast.success(t("research.mapping.removed"));
        },
    });

    // Deleting a saved mapping is irreversible and silently breaks price
    // resolution for the asset, so it confirms first like every other
    // destructive surface in the app.
    const handleRemove = async (
        id: number,
        provider: string,
        providerSymbol: string | null,
    ) => {
        const ok = await confirm({
            title: t("research.mapping.remove"),
            description: t("research.mapping.removeDesc", {
                provider,
                // A failed mapping has no provider symbol.
                symbol: providerSymbol ?? "—",
            }),
            confirmLabel: t("common.delete"),
            variant: "destructive",
        });
        if (ok) deleteMutation.mutate(id);
    };

    const auditMutation = useMutation({
        mutationFn: () =>
            apiClient.auditResearchMappings({
                instrument_key: instrumentKey,
                key_type: keyType,
            }),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: mappingsKey }),
    });
    const discrepancies = auditMutation.data?.data.discrepancies ?? [];

    const confirmableCount = useMemo(
        () =>
            proposals.filter((p) => isConfirmable(p) && selected[p.provider])
                .length,
        [proposals, selected],
    );

    const handleSave = () => {
        const toSave: MappingSaveInput[] = proposals
            .filter((p) => isConfirmable(p) && selected[p.provider])
            .map((p) => ({
                provider: p.provider,
                providerSymbol: p.providerSymbol!,
                resolvedName: p.resolvedName,
                exchange: p.exchange,
                currency: p.currency,
            }));
        if (toSave.length === 0) return;
        saveMutation.mutate(toSave);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("research.mapping.title")}</DialogTitle>
                    <DialogDescription>
                        {t("research.mapping.desc", {
                            name: displayName ?? instrumentKey,
                        })}
                    </DialogDescription>
                </DialogHeader>

                {/* Proposals */}
                <section className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="type-headline text-foreground">
                            {t("research.mapping.proposals")}
                        </h3>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => resolveMutation.mutate()}
                            disabled={resolveMutation.isPending}
                        >
                            <RefreshCw
                                className={cn(
                                    "h-4 w-4",
                                    resolveMutation.isPending && "animate-spin",
                                )}
                                aria-hidden="true"
                            />
                            {t("research.mapping.reresolve")}
                        </Button>
                    </div>

                    {resolveMutation.isPending ? (
                        <div {...loadingSurfaceProps} className="space-y-2">
                            {Array.from({ length: 3 }).map((_, i) => (
                                <Skeleton key={i} className="h-12 w-full" />
                            ))}
                        </div>
                    ) : resolveMutation.isError ? (
                        <Alert variant="destructive">
                            <AlertTriangle
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            <AlertDescription>
                                {t("research.mapping.resolveError")}
                            </AlertDescription>
                        </Alert>
                    ) : proposals.length === 0 ? (
                        <p className="py-2 type-callout text-label-secondary">
                            {t("research.mapping.noProposals")}
                        </p>
                    ) : (
                        <List>
                            {proposals.map((p) => {
                                const confirmable = isConfirmable(p);
                                const fromHolding = isFromHolding(p);
                                return (
                                    <ListRow
                                        key={p.provider}
                                        className={cn(
                                            !confirmable &&
                                                !fromHolding &&
                                                "opacity-70",
                                        )}
                                        leading={
                                            confirmable ? (
                                                <Checkbox
                                                    checked={
                                                        !!selected[p.provider]
                                                    }
                                                    onCheckedChange={(v) =>
                                                        setSelected((s) => ({
                                                            ...s,
                                                            [p.provider]:
                                                                v === true,
                                                        }))
                                                    }
                                                    aria-label={p.provider}
                                                />
                                            ) : fromHolding ? (
                                                <Check
                                                    className="text-success"
                                                    aria-label={t(
                                                        "research.mapping.fromHolding",
                                                    )}
                                                />
                                            ) : (
                                                <span aria-hidden="true" />
                                            )
                                        }
                                        title={
                                            <span className="inline-flex max-w-full flex-wrap items-center gap-2">
                                                <span className="font-medium">
                                                    {p.provider}
                                                </span>
                                                {p.providerSymbol && (
                                                    <Badge
                                                        variant="secondary"
                                                        size="sm"
                                                        className="font-mono"
                                                    >
                                                        {p.providerSymbol}
                                                    </Badge>
                                                )}
                                                <ProposalStatus
                                                    status={p.status}
                                                />
                                                {fromHolding && (
                                                    <Badge
                                                        variant="success"
                                                        size="sm"
                                                    >
                                                        {t(
                                                            "research.mapping.fromHolding",
                                                        )}
                                                    </Badge>
                                                )}
                                            </span>
                                        }
                                        /* resolved name + exchange + currency so the user can catch ticker collisions */
                                        subtitle={detailLine(
                                            p.resolvedName,
                                            p.exchange,
                                            p.currency,
                                        )}
                                    />
                                );
                            })}
                        </List>
                    )}
                </section>

                {/* Existing mappings */}
                <section className="space-y-2 border-t border-border/50 pt-4">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="type-headline text-foreground">
                            {t("research.mapping.existing")}
                        </h3>
                        {existing.length > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => auditMutation.mutate()}
                                disabled={auditMutation.isPending}
                            >
                                <ShieldCheck
                                    className={cn(
                                        "h-4 w-4",
                                        auditMutation.isPending &&
                                            "motion-safe:animate-pulse",
                                    )}
                                    aria-hidden="true"
                                />
                                {t("research.mapping.audit")}
                            </Button>
                        )}
                    </div>

                    {loadingExisting ? (
                        <Skeleton
                            {...loadingSurfaceProps}
                            className="h-10 w-full"
                        />
                    ) : existing.length === 0 ? (
                        <p className="py-2 type-callout text-label-secondary">
                            {t("research.mapping.noExisting")}
                        </p>
                    ) : (
                        <List>
                            {existing.map((m) => (
                                <ListRow
                                    key={m.id}
                                    title={
                                        <span className="inline-flex max-w-full items-center gap-2">
                                            <span className="font-medium">
                                                {m.provider}
                                            </span>
                                            <Badge
                                                variant="secondary"
                                                size="sm"
                                                className="font-mono"
                                            >
                                                {m.provider_symbol}
                                            </Badge>
                                        </span>
                                    }
                                    subtitle={detailLine(
                                        m.resolved_name,
                                        m.exchange,
                                        m.currency,
                                    )}
                                    trailing={
                                        <>
                                            {m.verified_at && (
                                                <Check
                                                    className="h-4 w-4 text-success"
                                                    aria-label={t(
                                                        "research.mapping.verified",
                                                    )}
                                                />
                                            )}
                                            <RowMenu
                                                label={t(
                                                    "research.mapping.rowMenu",
                                                    { provider: m.provider },
                                                )}
                                            >
                                                <DropdownMenuItem
                                                    variant="destructive"
                                                    onSelect={() =>
                                                        void handleRemove(
                                                            m.id,
                                                            m.provider,
                                                            m.provider_symbol,
                                                        )
                                                    }
                                                >
                                                    <Trash2 className="mr-2 h-4 w-4" />
                                                    {t(
                                                        "research.mapping.remove",
                                                    )}
                                                </DropdownMenuItem>
                                            </RowMenu>
                                        </>
                                    }
                                />
                            ))}
                        </List>
                    )}

                    {/* Audit discrepancies */}
                    {auditMutation.data &&
                        (discrepancies.length > 0 ? (
                            <Alert variant="destructive">
                                <AlertTriangle
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                                <AlertTitle>
                                    {t("research.mapping.discrepancies")}
                                </AlertTitle>
                                <AlertDescription>
                                    {discrepancies.map((d, i) => (
                                        <span key={i} className="block">
                                            {d.type === "currency_mismatch"
                                                ? t(
                                                      "research.mapping.currencyMismatch",
                                                  )
                                                : t(
                                                      "research.mapping.priceOutlier",
                                                  )}
                                            {d.provider
                                                ? ` — ${d.provider}`
                                                : ""}
                                        </span>
                                    ))}
                                </AlertDescription>
                            </Alert>
                        ) : (
                            <Alert variant="success">
                                <Check className="h-4 w-4" aria-hidden="true" />
                                <AlertDescription>
                                    {t("research.mapping.auditClean")}
                                </AlertDescription>
                            </Alert>
                        ))}
                </section>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button
                        onClick={handleSave}
                        disabled={
                            confirmableCount === 0 || saveMutation.isPending
                        }
                    >
                        {t("research.mapping.confirm", { n: confirmableCount })}
                    </Button>
                </DialogFooter>
            </DialogContent>
            <ConfirmDialog />
        </Dialog>
    );
}

function ProposalStatus({ status }: { status: MappingProposal["status"] }) {
    const { t } = useLanguage();
    const map: Record<
        string,
        { label: string; variant: BadgeProps["variant"] }
    > = {
        auto: {
            label: t("research.mapping.status.auto"),
            variant: "default",
        },
        confirmed: {
            label: t("research.mapping.status.confirmed"),
            variant: "success",
        },
        skipped: {
            label: t("research.mapping.status.skipped"),
            variant: "muted",
        },
        none: {
            label: t("research.mapping.status.none"),
            variant: "muted",
        },
        unavailable: {
            label: t("research.mapping.status.unavailable"),
            variant: "muted",
        },
        error: {
            label: t("research.mapping.status.error"),
            variant: "destructive",
        },
        failed: {
            label: t("research.mapping.status.error"),
            variant: "destructive",
        },
    };
    const entry = map[status] ?? map.none;
    return (
        <Badge variant={entry.variant} size="sm">
            {entry.label}
        </Badge>
    );
}
