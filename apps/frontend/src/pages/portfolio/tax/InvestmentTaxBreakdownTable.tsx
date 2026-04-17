import React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface InvestmentTaxRow {
  id: string | number;
  name: string;
  symbol?: string;
  assetClass: string;
  recordedTaxes: number;
  recordedFees: number;
  manualTaxes: number;
  manualFees: number;
  taxes: number;
  fees: number;
  total: number;
  realizedGain: number;
  currency?: string;
}

interface InvestmentTaxBreakdownTableProps {
  investments: InvestmentTaxRow[];
  fmt: (v: number) => string;
  convertToTarget: (amount: number, currency?: string) => number;
  t: (key: string) => string;
}

export function InvestmentTaxBreakdownTable({ investments, fmt, convertToTarget, t }: InvestmentTaxBreakdownTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.widget.investmentBreakdown")}</CardTitle>
        <CardDescription>{t("tax.investmentBreakdownDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {investments.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {inv.symbol && <span className="font-mono font-bold text-sm">{inv.symbol}</span>}
                  <span className="font-medium text-sm truncate">{inv.name}</span>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{inv.assetClass}</Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                  <span>
                    {t("tax.taxes")}: {fmt(inv.recordedTaxes)} + {fmt(inv.manualTaxes)}
                  </span>
                  <span>
                    {t("tax.fees")}: {fmt(inv.recordedFees)} + {fmt(inv.manualFees)}
                  </span>
                  {inv.realizedGain !== 0 && (
                    <span className={inv.realizedGain >= 0 ? "text-accent" : "text-destructive"}>
                      {t("tax.realized")}: {inv.realizedGain >= 0 ? "+" : ""}{fmt(convertToTarget(inv.realizedGain, inv.currency))}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-bold text-sm tabular-nums text-destructive">{fmt(inv.total)}</p>
                <p className="text-xs text-muted-foreground">{t("tax.totalCosts")}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
