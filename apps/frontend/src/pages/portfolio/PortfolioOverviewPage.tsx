import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, DollarSign, PieChart as PieChartIcon } from "lucide-react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
} from "recharts";

const COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(142, 76%, 36%)",
  "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)",
  "hsl(340, 82%, 52%)",
];

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(val);
}

// Mock data — will be replaced by backend
const portfolioSummary = {
  totalValue: 142580,
  totalGain: 18420,
  totalGainPercent: 14.8,
  monthlyChange: 2340,
};

const allocationData = [
  { name: "Stocks & ETFs", value: 78500 },
  { name: "Crypto", value: 24300 },
  { name: "Real Estate", value: 28000 },
  { name: "Savings & Bonds", value: 11780 },
];

const performanceData = [
  { month: "Sep", value: 118000 },
  { month: "Oct", value: 121500 },
  { month: "Nov", value: 125200 },
  { month: "Dec", value: 128900 },
  { month: "Jan", value: 132100 },
  { month: "Feb", value: 136800 },
  { month: "Mar", value: 134200 },
  { month: "Apr", value: 138400 },
  { month: "May", value: 140100 },
  { month: "Jun", value: 142580 },
];

export default function PortfolioOverviewPage() {
  const cards = [
    {
      title: "Total Portfolio Value",
      value: formatCurrency(portfolioSummary.totalValue),
      icon: DollarSign,
      description: "Across all asset classes",
      className: "text-primary",
    },
    {
      title: "Total Gain",
      value: formatCurrency(portfolioSummary.totalGain),
      icon: TrendingUp,
      description: `+${portfolioSummary.totalGainPercent}% all time`,
      className: "text-accent",
    },
    {
      title: "Monthly Change",
      value: formatCurrency(portfolioSummary.monthlyChange),
      icon: portfolioSummary.monthlyChange >= 0 ? TrendingUp : TrendingDown,
      description: "Compared to last month",
      className: portfolioSummary.monthlyChange >= 0 ? "text-accent" : "text-destructive",
    },
    {
      title: "Asset Classes",
      value: allocationData.length.toString(),
      icon: PieChartIcon,
      description: "Diversified portfolio",
      className: "text-primary",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Portfolio Overview</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
              <card.icon className={`h-4 w-4 ${card.className}`} />
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${card.className}`}>{card.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance chart */}
        <Card>
          <CardHeader>
            <CardTitle>Portfolio Performance</CardTitle>
            <CardDescription>Total value over time</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={performanceData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }}
                  formatter={(value: number) => formatCurrency(value)}
                />
                <defs>
                  <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="value" stroke="hsl(217, 91%, 60%)" fill="url(#portfolioGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Allocation pie */}
        <Card>
          <CardHeader>
            <CardTitle>Asset Allocation</CardTitle>
            <CardDescription>Portfolio distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={allocationData}
                  cx="50%"
                  cy="50%"
                  outerRadius={110}
                  innerRadius={55}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={{ strokeWidth: 1 }}
                >
                  {allocationData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }}
                  formatter={(value: number) => formatCurrency(value)}
                />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
