import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, type BarSeries } from "@/components/charts";

interface AssetClassTaxDatum {
  name: string;
  taxes: number;
  fees: number;
  total: number;
}

interface AssetClassTaxChartProps {
  data: AssetClassTaxDatum[];
  fmt: (v: number) => string;
  t: (key: string) => string;
}

export function AssetClassTaxChart({ data, fmt, t }: AssetClassTaxChartProps) {
  const series: BarSeries<AssetClassTaxDatum>[] = [
    {
      key: "taxes",
      label: t("tax.taxes"),
      accessor: (d) => d.taxes,
      color: "hsl(var(--chart-5))",
    },
    {
      key: "fees",
      label: t("tax.fees"),
      accessor: (d) => d.fees,
      color: "hsl(var(--chart-4))",
    },
  ];

  return (
    <Card className="glass-regular">
      <CardHeader>
        <CardTitle>{t("tax.widget.taxByAssetClass")}</CardTitle>
        <CardDescription>{t("tax.taxByAssetClassDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <BarChart
          data={data}
          categoryAccessor={(d) => d.name}
          series={series}
          height={280}
          valueTickFormat={fmt}
          tooltipValueFormat={(v) => fmt(v)}
        />
      </CardContent>
    </Card>
  );
}
