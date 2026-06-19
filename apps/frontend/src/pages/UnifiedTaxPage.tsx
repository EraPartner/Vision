/**
 * UnifiedTaxPage (ADR-098) — one owner-allocated view across earned income
 * (budgeting), dividend/interest income, and realized gains (portfolio), for the
 * Belgian marital quotient. Indicative: it COMPOSES existing figures (the
 * tax-profile gross + portfolio records), it is not a tax re-derivation.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Layers, Info, Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { apiClient } from "@/lib/api";

type Owner = "me" | "partner" | "joint";

export default function UnifiedTaxPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const currency = appSettings.defaultCurrency || "EUR";
  const { viewedYear, displayCalculationForYear } = useBelgianTaxProfile();
  const earnedIncome = displayCalculationForYear(viewedYear).grossIncome || 0;
  const [earnedIncomeOwner, setEarnedIncomeOwner] = useState<Owner>("me");

  const fmt = useMemo(() => new Intl.NumberFormat(undefined, {
    style: "currency", currency, maximumFractionDigits: 0,
  }), [currency]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["unified-tax", viewedYear, currency, earnedIncome, earnedIncomeOwner],
    queryFn: () => apiClient.getUnifiedTax({ year: viewedYear, currency, earnedIncome, earnedIncomeOwner }),
  });

  const KIND_LABELS: Record<string, string> = {
    earned_income: t("unifiedTax.kind.earned_income"),
    dividend_income: t("unifiedTax.kind.dividend_income"),
    realized_gains: t("unifiedTax.kind.realized_gains"),
  };
  const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("unifiedTax.title")}
        subtitle={t("unifiedTax.subtitle", { year: String(viewedYear) })}
        icon={Layers}
      />

      <Card className="!border-primary/50 bg-primary/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">{t("unifiedTax.disclaimer")}</p>
        </CardContent>
      </Card>

      <Card className="glass-regular">
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("unifiedTax.earnedIncome")}</span>
            <p className="text-lg font-semibold tabular-nums">{fmt.format(earnedIncome)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="earned-owner" className="text-xs text-muted-foreground">{t("unifiedTax.earnedIncomeOwner")}</Label>
            <Select value={earnedIncomeOwner} onValueChange={(v) => setEarnedIncomeOwner(v as Owner)}>
              <SelectTrigger id="earned-owner" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="me">{t("accounts.owner.me")}</SelectItem>
                <SelectItem value="partner">{t("accounts.owner.partner")}</SelectItem>
                <SelectItem value="joint">{t("accounts.owner.joint")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      )}
      {isError && <p className="text-sm text-destructive">{(error as Error)?.message}</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="glass-regular">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("unifiedTax.total")}</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold text-primary tabular-nums">{fmt.format(data.total)}</p></CardContent>
            </Card>
            <Card className="glass-regular">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("accounts.owner.me")}</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold tabular-nums">{fmt.format(data.byOwner.me)}</p></CardContent>
            </Card>
            <Card className="glass-regular">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("accounts.owner.partner")}</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold tabular-nums">{fmt.format(data.byOwner.partner)}</p></CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">{t("unifiedTax.byKind")}</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("unifiedTax.source")}</TableHead>
                    <TableHead className="text-right">{t("unifiedTax.amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(data.byKind).length === 0 && (
                    <TableRow><TableCell colSpan={2} className="text-center text-muted-foreground py-6">{t("unifiedTax.empty")}</TableCell></TableRow>
                  )}
                  {Object.entries(data.byKind).map(([kind, amount]) => (
                    <TableRow key={kind}>
                      <TableCell><Badge variant="outline" className="font-normal">{kindLabel(kind)}</Badge></TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{fmt.format(amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
