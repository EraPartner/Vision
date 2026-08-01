import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import type { ImportStagingRow, ImportPreviewGroup } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAccounts } from "@/hooks/useAccounts";
import { importKeys, invalidateAccountDerived, invalidateTransactionData, plannedKeys } from "@/lib/queryKeys";
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
import {
  DeferredRecipientCombobox,
  useRecipientComboboxLabel,
} from "@/components/shared/RecipientCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { formatCurrency } from "@/utils/currency";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { cn } from "@/lib/utils";

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

/**
 * Account identity is case/whitespace-insensitive (D1: `lower(btrim(name))`).
 * Mirror that normalization when cross-referencing staged bank_account labels
 * against the existing accounts list.
 */
function normalizeAccountName(name: string): string {
  return name.trim().toLowerCase();
}

interface AccountDisclosureEntry {
  /** Normalized key ("" = rows without an account label). */
  key: string;
  /** Display label as it appeared in the CSV (first spelling seen). */
  label: string;
  count: number;
  /** No existing account matches this label — commit will create one. */
  isNew: boolean;
  /** Rows carried no bank_account label at all. */
  isUnspecified: boolean;
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

  // One recipients subscription for the whole page. Every group's combobox is
  // deferred (query + list mount with its popover), so this single observer —
  // reading the exact page a closed combobox reads — paints all of their
  // labels and warms the cache their popovers open against. A year of bank CSV
  // is 100-300 groups; before this it was that many observers, debounce timers
  // and per-render page scans.
  const recipientLabelFor = useRecipientComboboxLabel();

  const { data: preview, isLoading, error } = useQuery({
    queryKey: importKeys.preview(batchId),
    queryFn: () => apiClient.getImportPreview(batchId),
    enabled: Number.isFinite(batchId),
  });

  // WP-B6 import disclosure — which accounts will this batch write to, and
  // will any of them be created on commit? Read-only: computed purely from the
  // staged rows' bank_account labels cross-referenced against the accounts
  // list under the D1 identity (lower/trim). No override picker.
  const { data: accountsData } = useAccounts({ active: "all" });

  const accountDisclosure = useMemo<AccountDisclosureEntry[]>(() => {
    if (!preview) return [];
    const buckets = new Map<string, { label: string; count: number }>();
    for (const row of preview.groups.flatMap((g) => g.rows)) {
      const label = (row.bank_account ?? "").trim();
      const key = normalizeAccountName(label);
      const bucket = buckets.get(key);
      if (bucket) bucket.count += 1;
      else buckets.set(key, { label, count: 1 });
    }
    const existing = new Set(
      (accountsData?.items ?? []).map((a) => normalizeAccountName(a.name)),
    );
    return [...buckets.entries()]
      .map(([key, { label, count }]) => ({
        key,
        label,
        count,
        isUnspecified: key === "",
        // Only flag "new" once the accounts list has loaded — an empty Set
        // while loading would badge every account as new for a frame.
        isNew: key !== "" && accountsData != null && !existing.has(key),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [preview, accountsData]);

  const newAccountCount = accountDisclosure.filter((e) => e.isNew).length;

  // These three are driven via `mutateAsync` and toast their own localized
  // copy in the callers' catch blocks — the meta flag keeps the global
  // mutation-error backstop from toasting the same failure twice.
  const overrideMutation = useMutation({
    mutationFn: ({ rowId, recipientId }: { rowId: number; recipientId: number | null }) =>
      apiClient.overrideImportRow(batchId, rowId, recipientId),
    meta: { suppressErrorToast: true },
  });

  const categoryOverrideMutation = useMutation({
    mutationFn: ({ rowId, categoryId }: { rowId: number; categoryId: number | null }) =>
      apiClient.overrideImportRowCategory(batchId, rowId, categoryId),
    meta: { suppressErrorToast: true },
  });

  const persistDefaultMutation = useMutation({
    mutationFn: ({ recipientId, categoryId }: { recipientId: number; categoryId: number | null }) =>
      apiClient.updateRecipient(recipientId, { default_category_id: categoryId }),
    meta: { suppressErrorToast: true },
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
        queryClient.invalidateQueries({ queryKey: plannedKeys.matchSuggestions });
        queryClient.invalidateQueries({ queryKey: plannedKeys.upcomingAll });
      }
      // WP-B6: committing rows under an unknown account label auto-creates the
      // account (DB trigger, migration 0056). Nudge the user to the accounts
      // hub to classify/name the new account(s), and refresh account-derived
      // views so the hub shows them immediately.
      if (newAccountCount > 0) {
        invalidateAccountDerived(queryClient);
        toast.success(t("importReview.toast.newAccounts", { n: newAccountCount }), {
          action: {
            label: t("importReview.toast.reviewAccounts"),
            onClick: () => navigate("/accounts"),
          },
          duration: 10000,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["import-batches"] });
      // A commit inserts the staged rows into `transactions`; refresh the
      // transactions list, dashboard stat cards, monthly summary and
      // aggregations so the imported rows appear immediately instead of after
      // staleTime expires (window-focus refetch is disabled globally).
      invalidateTransactionData(queryClient);
      navigate("/import");
    },
    onError: (err: Error) => {
      toast.error(t("importReview.toast.commitFailed"), { description: apiErrorToMessage(err, t) });
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
      queryClient.invalidateQueries({ queryKey: importKeys.preview(batchId) });
    } catch (err) {
      toast.error(t("importReview.toast.overrideFailed"), {
        description: apiErrorToMessage(err, t),
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
            description: apiErrorToMessage(persistErr, t),
          });
        }
      }
    } catch (err) {
      toast.error(t("importReview.toast.categoryOverrideFailed"), {
        description: apiErrorToMessage(err, t),
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

      {/* WP-B6 — per-account disclosure: where will this batch land? Read-only. */}
      {accountDisclosure.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border/60 px-4 py-3">
          {accountDisclosure.map((entry) => (
            <div
              key={entry.key || "__unspecified__"}
              className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
            >
              <span>{t("importReview.accounts.line", { n: entry.count })}</span>
              <span
                className={cn(
                  entry.isUnspecified ? "italic" : "font-semibold text-foreground",
                )}
              >
                {entry.isUnspecified
                  ? t("importReview.accounts.unspecified")
                  : entry.label}
              </span>
              {entry.isNew && (
                <Badge variant="outline" className="text-xs border-success/60 text-success">
                  {t("importReview.accounts.newBadge")}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}

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
                  <DeferredRecipientCombobox
                    value={effectiveRecipientId}
                    label={recipientLabelFor(effectiveRecipientId)}
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
                      <span className={cn("ml-auto shrink-0 tabular-nums font-medium", Number(row.amount) < 0 ? "text-loss" : "text-gain")}>
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
