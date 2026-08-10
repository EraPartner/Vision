/**
 * PortfolioImportReviewPage — resolve unmatched instruments and confirm a
 * portfolio import batch. Rows are grouped by investment; unmatched groups let
 * the user pick an existing holding or create a new one before committing.
 */

import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InvestmentCombobox } from "@/components/portfolio/InvestmentCombobox";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, PlusCircle } from "lucide-react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { apiClient } from "@/lib/api";
import type { PortfolioPreviewGroup } from "@/lib/api/portfolioImports";

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
      for (const row of g.rows) {
        await apiClient.overridePortfolioImportRow(batchId, row.id, { investmentId });
      }
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
      const [first, ...rest] = g.rows;
      const created = await apiClient.overridePortfolioImportRow(batchId, first.id, { createNew: true });
      const newId = created.investment_id;
      if (newId) {
        for (const row of rest) {
          await apiClient.overridePortfolioImportRow(batchId, row.id, { investmentId: newId });
        }
      }
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
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
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

              <div className="divide-y rounded-md border text-xs">
                {g.rows.map((row) => (
                  <div key={row.id} className="cv-auto-row flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
                    <span className="text-muted-foreground">{row.tx_date}</span>
                    <Badge variant="outline" className="font-normal">{row.type ?? row.type_raw}</Badge>
                    {row.units != null && <span>{row.units} @ {row.price_per_unit ?? "—"}</span>}
                    {row.amount != null && <span className="text-muted-foreground">{row.amount} {row.currency ?? ""}</span>}
                    {row.status === "error" && row.error_message && (
                      <span className="text-destructive">{row.error_message}</span>
                    )}
                  </div>
                ))}
              </div>
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
