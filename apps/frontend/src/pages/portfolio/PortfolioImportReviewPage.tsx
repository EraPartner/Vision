/**
 * PortfolioImportReviewPage — resolve unmatched instruments and confirm a
 * portfolio import batch. Rows are grouped by investment; unmatched groups let
 * the user pick an existing holding or create a new one before committing.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useParams, useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InvestmentCombobox } from "@/features/portfolio/InvestmentCombobox";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, PlusCircle } from "lucide-react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { apiClient } from "@/lib/api";
import type { PortfolioPreviewGroup, PortfolioPreviewRow } from "@/lib/api/portfolioImports";

/**
 * Seed height of a preview row (p-2 around a single line of text-xs content
 * plus the type Badge). Every mounted row reports its real height through
 * `measureElement`, and the first one to do so becomes the estimate for the
 * rows that have not been mounted yet — so the page's total height (and with
 * it the scrollbar) does not drift as the user scrolls a long group.
 */
const PREVIEW_ROW_ESTIMATE = 38;

/**
 * A group's preview rows. The page has no scroll container of its own — it
 * scrolls with the window — so this virtualizes against the window and
 * represents the rows outside the window as padding on the same box that used
 * to hold them all. Rows stay in normal flow (nothing absolutely positioned,
 * so a wrapping row can never overlap its neighbour) and keep their markup,
 * classes and separators: `divide-y` draws the separators between mounted
 * rows, and the topmost mounted row carries the one `divide-y` cannot draw
 * because it has no rendered predecessor.
 *
 * A multi-year brokerage import produces 500-2000+ rows across the groups; all
 * of them used to be mounted at once (`content-visibility` deferred their
 * paint, never their React/DOM cost).
 */
function PreviewRowList({ rows }: { rows: PortfolioPreviewRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rowEstimate, setRowEstimate] = useState(PREVIEW_ROW_ESTIMATE);
  // Where this group's row box sits in the document: the window virtualizer
  // maps the window's scroll offset onto row indexes through it. Anything above
  // the group changing height — another group's rows settling onto their
  // measured height — moves it, hence the document-level ResizeObserver.
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setScrollMargin((prev) => (Math.abs(prev - top) > 0.5 ? top : prev));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => rowEstimate,
    overscan: 8,
    scrollMargin,
  });

  // Adopt the first mounted row's real height as the estimate for the rest.
  // Rows in a group are homogeneous, so this keeps the virtual total within a
  // pixel of the real one instead of letting it converge while scrolling.
  useLayoutEffect(() => {
    const first = containerRef.current?.querySelector<HTMLElement>("[data-index]");
    if (!first) return;
    const height = first.getBoundingClientRect().height;
    if (height > 0) setRowEstimate((prev) => (Math.abs(prev - height) > 0.5 ? height : prev));
  }, [rows.length]);

  // `estimateSize` is not part of the measurements memo's key, so the adopted
  // estimate only takes effect once the virtualizer is told to re-measure.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowEstimate, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length ? items[0]!.start - scrollMargin : 0;
  const paddingBottom = items.length
    ? virtualizer.getTotalSize() - (items[items.length - 1]!.end - scrollMargin)
    : 0;

  return (
    <div
      ref={containerRef}
      className="divide-y rounded-md border text-xs"
      style={{ paddingTop, paddingBottom }}
    >
      {items.map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <div
            key={row.id}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 p-2${item.index > 0 ? " border-t" : ""}`}
          >
            <span className="text-muted-foreground">{row.tx_date}</span>
            <Badge variant="outline" className="font-normal">{row.type ?? row.type_raw}</Badge>
            {row.units != null && <span>{row.units} @ {row.price_per_unit ?? "—"}</span>}
            {row.amount != null && <span className="text-muted-foreground">{row.amount} {row.currency ?? ""}</span>}
            {row.status === "error" && row.error_message && (
              <span className="text-destructive">{row.error_message}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PortfolioImportReviewPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { batchId: batchIdParam } = useParams<{ batchId: string }>();
  const batchId = Number(batchIdParam);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);

  const queryKey = ["portfolio-import-preview", batchId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiClient.getPortfolioImportPreview(batchId),
    enabled: Number.isFinite(batchId),
  });

  const commit = useMutation({
    mutationFn: () => apiClient.commitPortfolioImportBatch(batchId),
    onSuccess: (res) => {
      toast.success(t("portfolioImport.toast.importSuccess", { n: res.imported, dups: res.duplicates }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      // Replace, don't push: this batch is consumed, so Back must skip the
      // review URL (it no longer previews) instead of re-inviting a commit.
      navigate("/portfolio", { replace: true });
    },
    onError: (err: Error) => toast.error(t("importPage.toast.serverError"), { description: apiErrorToMessage(err, t) }),
  });

  const groupKey = (g: PortfolioPreviewGroup) =>
    g.investment_id != null ? `inv:${g.investment_id}` : `raw:${(g.raw_symbol || g.raw_name || "?").toLowerCase()}`;

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const pickInvestment = async (g: PortfolioPreviewGroup, investmentId: number | null) => {
    if (investmentId == null) return;
    setBusyGroup(groupKey(g));
    try {
      await apiClient.overridePortfolioImportRows(batchId, g.rows.map((row) => row.id), { investmentId });
      await refresh();
    } catch (err) {
      toast.error(t("importPage.toast.serverError"), { description: apiErrorToMessage(err, t) });
    } finally {
      setBusyGroup(null);
    }
  };

  const createNew = async (g: PortfolioPreviewGroup) => {
    if (!g.rows.length) return;
    setBusyGroup(groupKey(g));
    try {
      await apiClient.overridePortfolioImportRows(batchId, g.rows.map((row) => row.id), { createNew: true });
      await refresh();
      toast.success(t("portfolioImport.toast.holdingCreated"));
    } catch (err) {
      toast.error(t("importPage.toast.serverError"), { description: apiErrorToMessage(err, t) });
    } finally {
      setBusyGroup(null);
    }
  };

  if (isLoading) {
    return <SectionLoader />;
  }
  if (error || !data) {
    return <div className="p-6 text-destructive">{t("importPage.failed")}</div>;
  }

  const unresolvedCount = data.totals.unresolved + data.totals.error;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{t("portfolioImport.review.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("portfolioImport.review.subtitle")}</p>
        </div>
        <div className="flex gap-2 text-xs">
          <Badge variant="secondary">{t("portfolioImport.review.matched", { n: data.totals.symbol + data.totals.name_exact })}</Badge>
          {unresolvedCount > 0 && (
            <Badge variant="outline" className="border-warning text-warning">
              {t("portfolioImport.review.unresolved", { n: unresolvedCount })}
            </Badge>
          )}
        </div>
      </div>

      {data.groups.map((g) => {
        const key = groupKey(g);
        // Brokerage cash group (ADR-095): no instrument to resolve — it commits as
        // plain cash transactions on the batch's sleeve.
        const resolved = g.is_cash || g.investment_id != null;
        const busy = busyGroup === key;
        return (
          <Card key={key} className={resolved ? "" : "border-warning/40"}>
            <CardHeader className="pb-2">
              <CardTitle variant="sm" className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {!resolved && <AlertTriangle className="h-4 w-4 text-warning" />}
                  {g.is_cash
                    ? t("portfolioImport.review.cashMovements")
                    : resolved
                      ? (g.investment_symbol ? `${g.investment_name} (${g.investment_symbol})` : g.investment_name)
                      : (g.raw_symbol || g.raw_name || t("portfolioImport.review.unknownInstrument"))}
                  <Badge variant="secondary" className="font-normal">{g.row_count}</Badge>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!g.is_cash && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("portfolioImport.review.holding")}</span>
                <InvestmentCombobox
                  value={g.investment_id}
                  onSelect={(id) => pickInvestment(g, id)}
                  disabled={busy}
                />
                {!resolved && (
                  <Button size="sm" variant="outline" onClick={() => createNew(g)} disabled={busy}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5 mr-1" />}
                    {t("portfolioImport.review.createNew")}
                  </Button>
                )}
              </div>
              )}

              <PreviewRowList rows={g.rows} />
            </CardContent>
          </Card>
        );
      })}

      <div className="flex gap-2">
        <Button onClick={() => commit.mutate()} disabled={commit.isPending} className="flex-1 h-11" size="lg">
          {commit.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
          {t("portfolioImport.review.commit")}
        </Button>
        <Button variant="outline" size="lg" className="h-11" onClick={() => navigate("/portfolio")}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

export default PortfolioImportReviewPage;
