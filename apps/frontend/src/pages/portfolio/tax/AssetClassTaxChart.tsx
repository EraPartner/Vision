import { BarChart, ChartCard, type BarSeries } from "@/components/charts";

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
    <ChartCard
      title={t("tax.widget.taxByAssetClass")}
      description={t("tax.taxByAssetClassDesc")}
      legend={series.map((s) => ({ label: s.label ?? s.key, color: s.color ?? "hsl(var(--chart-1))" }))}
    >
      <BarChart
        data={data}
        categoryAccessor={(d) => d.name}
        series={series}
        height={280}
        valueTickFormat={fmt}
        tooltipValueFormat={(v) => fmt(v)}
      />
    </ChartCard>
  );
}
