import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import type { ImportPreviewGroup, ImportStagingRow } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { formatCurrency } from "@/utils/currency";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";

type MatchSource = "exact" | "fuzzy" | "pattern" | "new" | null;

interface GroupState {
  recipientId: number | null;
  recipientName: string | null;
  saving: boolean;
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
        <Badge variant="outline" className="text-xs border-amber-400 text-amber-600 dark:text-amber-400">
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
        <Badge variant="outline" className="text-xs border-emerald-400 text-emerald-600 dark:text-emerald-400">
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
  const locale = numberFormatToLocale(appSettings?.numberFormat ?? "en-US");

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
      queryClient.invalidateQueries({ queryKey: ["import-batches"] });
      navigate("/import");
    },
    onError: (err: Error) => {
      toast.error(t("importReview.toast.commitFailed"), { description: err.message });
    },
  });

  const handleGroupOverride = async (
    groupKey: string,
    rows: ImportStagingRow[],
    recipientId: number | null,
    recipientName: string | null,
  ) => {
    setGroupOverrides((prev) => {
      const next = new Map(prev);
      next.set(groupKey, { recipientId, recipientName, saving: true });
      return next;
    });

    try {
      await Promise.all(rows.map((row) => overrideMutation.mutateAsync({ rowId: row.id, recipientId })));
      setGroupOverrides((prev) => {
        const next = new Map(prev);
        next.set(groupKey, { recipientId, recipientName, saving: false });
        return next;
      });
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

  const totalRows = preview?.groups.reduce((sum, g) => sum + g.row_count, 0) ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
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
            <Badge variant="outline" className="text-xs border-amber-400 text-amber-600 dark:text-amber-400 mr-1">fuzzy</Badge>
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
            <Badge variant="outline" className="text-xs border-emerald-400 text-emerald-600 dark:text-emerald-400 mr-1">new</Badge>
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
          const groupKey = String(group.recipient_id ?? "__unresolved__");
          const override = groupOverrides.get(groupKey);
          const effectiveName = override?.recipientName ?? group.recipient_name;
          const effectiveRecipientId = override !== undefined ? override.recipientId : group.recipient_id;
          const dominant = dominantMatchSource(group.rows);
          const isNew = group.recipient_id == null || dominant === "new";

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
                  {override?.saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  <RecipientCombobox
                    value={effectiveRecipientId}
                    onSelect={(id, name) => handleGroupOverride(groupKey, group.rows, id, name)}
                    className="h-7 text-xs max-w-[180px]"
                    disabled={override?.saving}
                  />
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-2">
                {group.matched_pattern_text && (
                  <p className="text-xs text-muted-foreground mb-3 font-mono truncate">
                    {t("importReview.pattern")}: {group.matched_pattern_text}
                  </p>
                )}
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
                      <span className={`ml-auto shrink-0 tabular-nums font-medium ${Number(row.amount) < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}>
                        {formatCurrency(Math.abs(Number(row.amount)), row.currency ?? "EUR", locale)}
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
