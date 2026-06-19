/**
 * RebalancePage (ADR-098) — cash-aware rebalancing. Picks a target allocation
 * (a preset model or the current mix as a starting point), then asks the server
 * how to deploy spendable budgeting cash into underweight sleeves without selling.
 */
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Scale, Loader2, ArrowDownToLine } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { apiClient } from "@/lib/api";
import type { ModelPortfolio, RebalanceResponse } from "@/lib/api/crossWorkspace";

const MODELS: ModelPortfolio[] = ["sixty_forty", "all_weather", "three_fund"];

export default function RebalancePage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const currency = appSettings.defaultCurrency || "EUR";
  const [model, setModel] = useState<ModelPortfolio>("sixty_forty");

  const fmt = useMemo(() => new Intl.NumberFormat(undefined, {
    style: "currency", currency, maximumFractionDigits: 0,
  }), [currency]);
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

  const compute = useMutation({
    mutationFn: () => apiClient.computeRebalance({ model, currency }),
  });
  const result: RebalanceResponse | undefined = compute.data;

  const totalDeployed = result
    ? Object.values(result.deployment).reduce((s, v) => s + v, 0)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("rebalance.title")}
        subtitle={t("rebalance.subtitle")}
        icon={Scale}
      />

      <Card className="glass-regular">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="rebalance-model">
              {t("rebalance.targetModel")}
            </label>
            <Select value={model} onValueChange={(v) => setModel(v as ModelPortfolio)}>
              <SelectTrigger id="rebalance-model" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m} value={m}>{t(`rebalance.model.${m}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => compute.mutate()} disabled={compute.isPending} className="gap-2">
            {compute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scale className="h-4 w-4" />}
            {t("rebalance.compute")}
          </Button>
        </CardContent>
      </Card>

      {compute.isError && (
        <p className="text-sm text-destructive">{(compute.error as Error)?.message}</p>
      )}

      {result && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card className="glass-regular">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("rebalance.availableCash")}</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold text-primary">{fmt.format(result.availableCash)}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("rebalance.availableCashHint")}</p></CardContent>
            </Card>
            <Card className="glass-regular">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("rebalance.totalDeployed")}</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold text-accent">{fmt.format(totalDeployed)}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("rebalance.totalDeployedHint")}</p></CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ArrowDownToLine className="h-4 w-4" />{t("rebalance.plan")}</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("rebalance.sleeve")}</TableHead>
                    <TableHead className="text-right">{t("rebalance.current")}</TableHead>
                    <TableHead className="text-right">{t("rebalance.target")}</TableHead>
                    <TableHead className="text-right">{t("rebalance.deploy")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from(new Set([
                    ...Object.keys(result.actualValues),
                    ...Object.keys(result.targetWeights),
                  ])).sort().map((sleeve) => {
                    const deploy = result.deployment[sleeve] ?? 0;
                    return (
                      <TableRow key={sleeve}>
                        <TableCell className="font-medium">{sleeve}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt.format(result.actualValues[sleeve] ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{pct(result.targetWeights[sleeve] ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {deploy > 0 ? <Badge variant="secondary">+{fmt.format(deploy)}</Badge> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-3">{t("rebalance.noSellNote")}</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
