import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
  AlertTriangle, Check, Link2, RefreshCw, ShieldCheck, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import type {
  MappingKeyType, MappingProposal, MappingSaveInput, ResearchAssetClass,
} from "@/types/research";

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
  return !!p.providerSymbol && !isFromHolding(p) && (p.status === "auto" || p.status === "confirmed");
}

export function ResearchMappingDialog({
  open, onOpenChange, instrumentKey, keyType = "isin", query, assetClass, displayName, investmentId,
}: ResearchMappingDialogProps) {
  const { t } = useLanguage();
  const loadingSurfaceProps = useLoadingSurfaceProps();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const mappingsKey = ["research-mappings", instrumentKey, keyType] as const;

  // Existing stored mappings.
  const { data: existingResult, isFetching: loadingExisting } = useQuery({
    queryKey: mappingsKey,
    queryFn: () => apiClient.getResearchMappings(instrumentKey, keyType),
    enabled: open && !!instrumentKey,
    staleTime: 60_000,
  });
  const existing = existingResult?.data.items ?? [];

  // Resolve proposals (auto-propose per provider). Does not persist.
  const resolveMutation = useMutation({
    mutationFn: () => apiClient.resolveResearchMappings({
      instrument_key: instrumentKey, key_type: keyType, asset_class: assetClass, query,
      ...(investmentId !== undefined ? { investment_id: investmentId } : {}),
    }),
  });
  const proposals = useMemo(
    () => resolveMutation.data?.data.proposals ?? [],
    [resolveMutation.data],
  );

  // Auto-resolve once when the dialog opens.
  useEffect(() => {
    if (open && instrumentKey && query && !resolveMutation.data && !resolveMutation.isPending) {
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
      apiClient.saveResearchMappings({ instrument_key: instrumentKey, key_type: keyType, mappings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mappingsKey });
      toast.success(t('research.mapping.saved'));
    },
    onError: () => toast.error(t('research.mapping.saveError')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.deleteResearchMapping(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mappingsKey });
      toast.success(t('research.mapping.removed'));
    },
  });

  const auditMutation = useMutation({
    mutationFn: () => apiClient.auditResearchMappings({ instrument_key: instrumentKey, key_type: keyType }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mappingsKey }),
  });
  const discrepancies = auditMutation.data?.data.discrepancies ?? [];

  const confirmableCount = useMemo(
    () => proposals.filter((p) => isConfirmable(p) && selected[p.provider]).length,
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
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" /> {t('research.mapping.title')}
          </DialogTitle>
          <DialogDescription>
            {t('research.mapping.desc', { name: displayName ?? instrumentKey })}
          </DialogDescription>
        </DialogHeader>

        {/* Proposals */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">{t('research.mapping.proposals')}</h4>
            <Button
              variant="ghost" size="sm" className="text-xs gap-1.5"
              onClick={() => resolveMutation.mutate()}
              disabled={resolveMutation.isPending}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", resolveMutation.isPending && "animate-spin")} />
              {t('research.mapping.reresolve')}
            </Button>
          </div>

          {resolveMutation.isPending ? (
            <div {...loadingSurfaceProps} className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">{t('research.mapping.noProposals')}</p>
          ) : (
            <ul className="space-y-2">
              {proposals.map((p) => {
                const confirmable = isConfirmable(p);
                const fromHolding = isFromHolding(p);
                return (
                  <li
                    key={p.provider}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border border-border p-3",
                      fromHolding && "border-success/40 bg-success/5",
                      !confirmable && !fromHolding && "opacity-70",
                    )}
                  >
                    {confirmable && (
                      <Checkbox
                        className="mt-0.5"
                        checked={!!selected[p.provider]}
                        onCheckedChange={(v) =>
                          setSelected((s) => ({ ...s, [p.provider]: v === true }))}
                        aria-label={p.provider}
                      />
                    )}
                    {fromHolding && (
                      <Check className="mt-0.5 h-4 w-4 text-success shrink-0" aria-label={t('research.mapping.fromHolding')} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{p.provider}</span>
                        {p.providerSymbol && (
                          <Badge variant="secondary" className="font-mono text-[10px]">{p.providerSymbol}</Badge>
                        )}
                        <ProposalStatus status={p.status} />
                        {fromHolding && (
                          <Badge variant="outline" className="text-[10px] border-success/30 text-success">
                            {t('research.mapping.fromHolding')}
                          </Badge>
                        )}
                      </div>
                      {/* resolved name + exchange + currency so the user can catch ticker collisions */}
                      {(p.resolvedName || p.exchange || p.currency) && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {[p.resolvedName, p.exchange, p.currency].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Existing mappings */}
        <section className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">{t('research.mapping.existing')}</h4>
            {existing.length > 0 && (
              <Button
                variant="outline" size="sm" className="text-xs gap-1.5"
                onClick={() => auditMutation.mutate()}
                disabled={auditMutation.isPending}
              >
                <ShieldCheck className={cn("h-3.5 w-3.5", auditMutation.isPending && "motion-safe:animate-pulse")} />
                {t('research.mapping.audit')}
              </Button>
            )}
          </div>

          {loadingExisting ? (
            <Skeleton {...loadingSurfaceProps} className="h-10 w-full" />
          ) : existing.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">{t('research.mapping.noExisting')}</p>
          ) : (
            <ul className="space-y-2">
              {existing.map((m) => (
                <li key={m.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                  <span className="font-semibold text-sm w-24 shrink-0">{m.provider}</span>
                  <Badge variant="secondary" className="font-mono text-[10px]">{m.provider_symbol}</Badge>
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {[m.resolved_name, m.exchange, m.currency].filter(Boolean).join(" · ")}
                  </span>
                  {m.verified_at && <Check className="h-3.5 w-3.5 text-success shrink-0" aria-label={t('research.mapping.verified')} />}
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteMutation.mutate(m.id)}
                    aria-label={t('research.mapping.remove')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {/* Audit discrepancies */}
          {auditMutation.data && (
            discrepancies.length > 0 ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-1">
                <p className="text-xs font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> {t('research.mapping.discrepancies')}
                </p>
                {discrepancies.map((d, i) => (
                  <p key={i} className="text-xs text-foreground/80">
                    {d.type === "currency_mismatch"
                      ? t('research.mapping.currencyMismatch')
                      : t('research.mapping.priceOutlier')}
                    {d.provider ? ` — ${d.provider}` : ""}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs text-success flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5" /> {t('research.mapping.auditClean')}
              </p>
            )
          )}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} disabled={confirmableCount === 0 || saveMutation.isPending}>
            {t('research.mapping.confirm', { n: confirmableCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProposalStatus({ status }: { status: MappingProposal["status"] }) {
  const { t } = useLanguage();
  const map: Record<string, { label: string; className: string }> = {
    auto: { label: t('research.mapping.status.auto'), className: "border-primary/30 text-primary" },
    confirmed: { label: t('research.mapping.status.confirmed'), className: "border-success/30 text-success" },
    skipped: { label: t('research.mapping.status.skipped'), className: "text-muted-foreground" },
    none: { label: t('research.mapping.status.none'), className: "text-muted-foreground" },
    unavailable: { label: t('research.mapping.status.unavailable'), className: "text-muted-foreground" },
    error: { label: t('research.mapping.status.error'), className: "border-destructive/30 text-destructive" },
    failed: { label: t('research.mapping.status.error'), className: "border-destructive/30 text-destructive" },
  };
  const entry = map[status] ?? map.none;
  return <Badge variant="outline" className={cn("text-[10px]", entry.className)}>{entry.label}</Badge>;
}
