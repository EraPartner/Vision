import React from "react";
import { ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  color: "hsl(var(--card-foreground))",
};

interface AssetClassTaxChartProps {
  data: { name: string; taxes: number; fees: number; total: number }[];
  fmt: (v: number) => string;
  t: (key: string) => string;
}

export function AssetClassTaxChart({ data, fmt, t }: AssetClassTaxChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.widget.taxByAssetClass")}</CardTitle>
        <CardDescription>{t("tax.taxByAssetClassDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
            <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => fmt(v)} />
            <Bar dataKey="taxes" name={t("tax.taxes")} fill="hsl(340, 82%, 52%)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="fees" name={t("tax.fees")} fill="hsl(45, 93%, 47%)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
