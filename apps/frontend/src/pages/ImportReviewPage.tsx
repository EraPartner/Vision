import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import type { ImportStagingRow, ImportPreviewGroup } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { invalidateTransactionLists } from "@/hooks/useTransactions";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { formatCurrency } from "@/utils/currency";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";

type MatchSource = "exact" | "fuzzy" | "pattern" | "new" | null;

interface GroupState {
  recipientId: number | null;
  recipientName: string | null;
  categoryId: number | null;
  categoryLabel: string | null;
  persistAsDefault: boolean;
  recipientSaving: boolean;
  categorySaving: boolean;
}

function matchSourceBadge(source: MatchSource, similarity?: number | null) {
  switch (source) {
    case "exact":
      return (
        <Badge variant="outline" className="text-xs border-muted-foreground/30 text-muted-foreground">
          exact
        </Badge>
      );
    case "fuzzy":
      return (
        <Badge variant="outline" className="text-xs border-warning/60 text-warning">
          fuzzy {similarity != null ? (similarity * 100).toFixed(0) + "%" : ""}
        </Badge>
      );
    case "pattern":
      return (
        <Badge variant="outline" className="text-xs border-blue-400 text-blue-600 dark:text-blue-400">
          pattern
        </Badge>
      );
    case "new":
      return (
        <Badge variant="outline" className="text-xs border-success/60 text-success">
          new
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs border-destructive/50 text-destructive">
          unresolved
        </Badge>
      );
  }
}

function dominantMatchSource(rows: ImportStagingRow[]): MatchSource {
  for (const src of ["new", "fuzzy", "pattern", "exact"] as MatchSource[]) {
    if (rows.some((r) => r.match_source === src)) return src;
  }
  return null;
}

function formatDate(raw: string): string {
  return String(raw).slice(0, 10);
}

export default function ImportReviewPage() {
  const { batchId: batchIdParam } = useParams<{ batchId: string }>();
  const batchId = Number(batchIdParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings?.numberFormat ?? "us");

  const [groupOverrides, setGroupOverrides] = useState<Map<string, GroupState>>(new Map());

  const { data: preview, isLoading, error } = useQuery({
    queryKey: ["import-preview", batchId],
    queryFn: () => apiClient.getImportPreview(batchId),
    enabled: Number.isFinite(batchId),
  });

  const overrideMutation = useMutation({
    mutationFn: ({ rowId, recipientId }: { rowId: number; recipientId: number | null }) =>
      apiClient.overrideImportRow(batchId, rowId, recipientId),
  });

  const categoryOverrideMutation = useMutation({
    mutationFn: ({ rowId, categoryId }: { rowId: number; categoryId: number | null }) =>
      apiClient.overrideImportRowCategory(batchId, rowId, categoryId),
  });

  const persistDefaultMutation = useMutation({
    mutationFn: ({ recipientId, categoryId }: { recipientId: number; categoryId: number | null }) =>
      apiClient.updateRecipient(recipientId, { default_category_id: categoryId }),
  });

  const commitMutation = useMutation({
    mutationFn: () => apiClient.commitImportBatch(batchId),
    onSuccess: (data) => {
      toast.success(
        t("importReview.toast.success", {
          imported: data.imported,
          duplicates: data.duplicates,
          errors: data.errors,
        }),
        { icon: <CheckCircle2 className="h-4 w-4" /> }
      );
      if (data.auto_linked_count && data.auto_linked_count > 0) {
        toast.success(t("importReview.toast.autoLinked", { n: data.auto_linked_count }));
        queryClient.invalidateQueries({ queryKey: ["plannedMatchSuggestions"] });
        queryClient.invalidateQueries({ queryKey: ["upcomingPlannedPayments"] });
      }
      queryClient.invalidateQueries({ queryKey: ["import-batches"] });
      // A commit inserts the staged rows into `transactions`; refresh the
      // transactions list, dashboard stat cards, monthly summary and
      // aggregations so the imported rows appear immediately instead of after
      // staleTime expires (window-focus refetch is disabled globally).
      invalidateTransactionLists(queryClient);
      navigate("/import");
    },
    onError: (err: Error) => {
      toast.error(t("importReview.toast.commitFailed"), { description: err.message });
    },
  });

  const groupStateFor = (group: ImportPreviewGroup, key: string): GroupState => {
    const existing = groupOverrides.get(key);
    if (existing) return existing;
    return {
      recipientId: group.recipient_id,
      recipientName: group.recipient_name,
      categoryId: group.current_category_id,
      categoryLabel: group.current_category_label,
      // Default the persist checkbox ON when the recipient has no current
      // default — most common case where the user wants to set one.
      persistAsDefault: group.recipient_default_category_id == null,
      recipientSaving: false,
      categorySaving: false,
    };
  };

  const updateGroupState = (groupKey: string, patch: Partial<GroupState>, fallback: GroupState) => {
    setGroupOverrides((prev) => {
      const next = new Map(prev);
      const current = next.get(groupKey) ?? fallback;
      next.set(groupKey, { ...current, ...patch });
      return next;
    });
  };

  const handleGroupOverride = async (
    groupKey: string,
    fallback: GroupState,
    rows: ImportStagingRow[],
    recipientId: number | null,
    recipientName: string | null,
  ) => {
    updateGroupState(groupKey, { recipientId, recipientName, recipientSaving: true }, fallback);

    try {
      await Promise.all(rows.map((row) => overrideMutation.mutateAsync({ rowId: row.id, recipientId })));
      updateGroupState(groupKey, { recipientSaving: false }, fallback);
      // Recipient changed — recipient default category may differ. Refresh.
      queryClient.invalidateQueries({ queryKey: ["import-preview", batchId] });
    } catch (err) {
      toast.error(t("importReview.toast.overrideFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
      setGroupOverrides((prev) => {
        const next = new Map(prev);
        next.delete(groupKey);
        return next;
      });
    }
  };

  const handleCategoryOverride = async (
    groupKey: string,
    fallback: GroupState,
    rows: ImportStagingRow[],
    categoryId: number | null,
    categoryLabel: string | null,
  ) => {
    updateGroupState(
      groupKey,
      { categoryId, categoryLabel, categorySaving: true },
      fallback,
    );

    try {
      await Promise.all(
        rows.map((row) => categoryOverrideMutation.mutateAsync({ rowId: row.id, categoryId })),
      );
      updateGroupState(groupKey, { categorySaving: false }, fallback);

      const state = groupOverrides.get(groupKey) ?? fallback;
      const persist = (groupOverrides.get(groupKey)?.persistAsDefault ?? fallback.persistAsDefault);
      const targetRecipientId = (groupOverrides.get(groupKey)?.recipientId ?? state.recipientId);

      if (persist && targetRecipientId != null && categoryId != null) {
        try {
          await persistDefaultMutation.mutateAsync({
            recipientId: targetRecipientId,
            categoryId,
          });
        } catch (persistErr) {
          toast.error(t("importReview.toast.persistDefaultFailed"), {
            description: persistErr instanceof Error ? persistErr.message : undefined,
          });
        }
      }
    } catch (err) {
      toast.error(t("importReview.toast.categoryOverrideFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
      updateGroupState(groupKey, { categorySaving: false }, fallback);
    }
  };

  const handlePersistDefaultToggle = (
    groupKey: string,
    fallback: GroupState,
    next: boolean,
  ) => {
    updateGroupState(groupKey, { persistAsDefault: next }, fallback);
  };

  const totalRows = preview?.groups.reduce((sum, g) => sum + g.row_count, 0) ?? 0;

  if (isLoading) {
    return (
      <SectionLoader />
    );
  }

  if (error || !preview) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto">
        <Button variant="ghost" size="sm" onClick={() => navigate("/import")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("importReview.back")}
        </Button>
        <p className="text-destructive text-sm">
          {error instanceof Error ? error.message : t("importReview.loadError")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto animate-in">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate("/import")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("importReview.back")}
        </Button>
      </div>

      <PageHeader
        title={t("importReview.title")}
        subtitle={t("importReview.subtitle", { n: totalRows })}
      />

      {/* Summary badges */}
      <div className="flex flex-wrap gap-2 text-sm">
        {preview.totals.exact > 0 && (
          <span className="text-muted-foreground">
            <Badge variant="outline" className="text-xs border-muted-foreground/30 text-muted-foreground mr-1">exact</Badge>
            {preview.totals.exact}
          </span>
        )}
        {preview.totals.fuzzy > 0 && (
          <span className="text-muted-foreground">
            <Badge variant="outline" className="text-xs border-warning/60 text-warning mr-1">fuzzy</Badge>
            {preview.totals.fuzzy}
          </span>
        )}
        {preview.totals.pattern > 0 && (
          <span className="text-muted-foreground">
            <Badge variant="outline" className="text-xs border-blue-400 text-blue-600 dark:text-blue-400 mr-1">pattern</Badge>
            {preview.totals.pattern}
          </span>
        )}
        {preview.totals.new > 0 && (
          <span className="text-muted-foreground">
            <Badge variant="outline" className="text-xs border-success/60 text-success mr-1">new</Badge>
            {preview.totals.new}
          </span>
        )}
        {preview.totals.unresolved > 0 && (
          <span className="text-muted-foreground">
            <Badge variant="outline" className="text-xs border-destructive/50 text-destructive mr-1">unresolved</Badge>
            {preview.totals.unresolved}
          </span>
        )}
      </div>

      {/* Groups accordion */}
      <Accordion type="multiple" className="space-y-2">
        {preview.groups.map((group) => {
          const groupKey = group.recipient_id != null
            ? String(group.recipient_id)
            : `__unresolved__:${group.recipient_name ?? ""}:${group.rows[0]?.memo ?? ""}`;
          const fallbackState = groupStateFor(group, groupKey);
          const state = groupOverrides.get(groupKey) ?? fallbackState;
          const effectiveName = state.recipientName ?? group.recipient_name;
          const effectiveRecipientId = state.recipientId;
          const effectiveCategoryId = state.categoryId;
          const dominant = dominantMatchSource(group.rows);
          const isNew = group.recipient_id == null || dominant === "new";
          const persistCheckboxId = `persist-default-${groupKey}`;

          return (
            <AccordionItem
              key={groupKey}
              value={groupKey}
              className="border border-border/60 rounded-lg overflow-hidden"
            >
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {matchSourceBadge(dominant)}
                  <span className="font-medium text-sm truncate">
                    {isNew && !effectiveName
                      ? t("importReview.newRecipient")
                      : effectiveName ?? t("importReview.unresolved")}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t("importReview.rowCount", { n: group.row_count })}
                  </span>
                </div>
                <div
                  className="flex items-center gap-2 mr-2 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {(state.recipientSaving || state.categorySaving) && (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  )}
                  <RecipientCombobox
                    value={effectiveRecipientId}
                    onSelect={(id, name) =>
                      handleGroupOverride(groupKey, fallbackState, group.rows, id, name)
                    }
                    className="h-7 text-xs max-w-[180px]"
                    disabled={state.recipientSaving}
                  />
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-3">
                {group.matched_pattern_text && (
                  <p className="text-xs text-muted-foreground mb-3 font-mono truncate">
                    {t("importReview.pattern")}: {group.matched_pattern_text}
                  </p>
                )}

                {/* Category controls — apply to all rows in the group. */}
                <div
                  className="flex flex-wrap items-center gap-3 mb-3 pb-3 border-b border-border/40"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t("importReview.category")}
                  </span>
                  <CategoryCombobox
                    value={effectiveCategoryId}
                    onSelect={(id, label) =>
                      handleCategoryOverride(groupKey, fallbackState, group.rows, id, label)
                    }
                    className="h-7 text-xs max-w-[260px]"
                    disabled={state.categorySaving || effectiveRecipientId == null}
                  />
                  {effectiveRecipientId != null && (
                    <label
                      htmlFor={persistCheckboxId}
                      className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"
                    >
                      <Checkbox
                        id={persistCheckboxId}
                        checked={state.persistAsDefault}
                        onCheckedChange={(checked) =>
                          handlePersistDefaultToggle(groupKey, fallbackState, checked === true)
                        }
                        disabled={state.categorySaving}
                      />
                      {t("importReview.persistDefault")}
                    </label>
                  )}
                </div>

                <div className="space-y-1">
                  {group.rows.map((row) => (
                    <div
                      key={row.id}
                      className="flex items-center gap-3 py-1.5 text-xs border-b border-border/30 last:border-0"
                    >
                      <div className="shrink-0">{matchSourceBadge(row.match_source, row.match_similarity)}</div>
                      <span className="text-muted-foreground shrink-0 tabular-nums">{formatDate(row.tx_date)}</span>
                      <span className="truncate min-w-0 text-foreground/80">{row.recipient_raw}</span>
                      {row.memo && (
                        <span className="truncate min-w-0 text-muted-foreground/60 hidden sm:block">{row.memo}</span>
                      )}
                      <span className={`ml-auto shrink-0 tabular-nums font-medium ${Number(row.amount) < 0 ? "text-destructive" : "text-success"}`}>
                        {formatCurrency(Number(row.amount), row.currency ?? "EUR", locale)}
                      </span>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {/* Approve button */}
      <div className="flex justify-end pt-2 pb-8">
        <Button
          size="lg"
          className="h-11 px-8"
          onClick={() => commitMutation.mutate()}
          disabled={commitMutation.isPending}
        >
          {commitMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t("importReview.committing")}
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t("importReview.approve", { n: totalRows })}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
