import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "EUR", minimumFractionDigits: 2,
  }).format(val);
}

// Mock data
const holdings = [
  { symbol: "VWCE", name: "Vanguard FTSE All-World", shares: 45, avgPrice: 98.5, currentPrice: 112.3, change: 4.2 },
  { symbol: "IWDA", name: "iShares MSCI World", shares: 30, avgPrice: 78.2, currentPrice: 85.7, change: 1.8 },
  { symbol: "AAPL", name: "Apple Inc.", shares: 10, avgPrice: 145.0, currentPrice: 178.5, change: -0.6 },
  { symbol: "MSFT", name: "Microsoft Corp.", shares: 8, avgPrice: 310.0, currentPrice: 385.2, change: 2.1 },
  { symbol: "VUSA", name: "Vanguard S&P 500", shares: 60, avgPrice: 62.4, currentPrice: 71.8, change: 0.9 },
];

const chartData = [
  { month: "Jan", value: 62000 }, { month: "Feb", value: 64200 }, { month: "Mar", value: 63800 },
  { month: "Apr", value: 67100 }, { month: "May", value: 71500 }, { month: "Jun", value: 78500 },
];

export default function StocksPage() {
  const totalValue = holdings.reduce((s, h) => s + h.shares * h.currentPrice, 0);
  const totalCost = holdings.reduce((s, h) => s + h.shares * h.avgPrice, 0);
  const totalGain = totalValue - totalCost;
  const gainPercent = (totalGain / totalCost) * 100;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Stocks & ETFs</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Value</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{formatCurrency(totalValue)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Gain/Loss</CardTitle></CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalGain >= 0 ? "text-accent" : "text-destructive"}`}>
              {totalGain >= 0 ? "+" : ""}{formatCurrency(totalGain)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{gainPercent >= 0 ? "+" : ""}{gainPercent.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Holdings</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-foreground">{holdings.length}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance</CardTitle>
          <CardDescription>Portfolio value over time</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
              <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }} formatter={(v: number) => formatCurrency(v)} />
              <Line type="monotone" dataKey="value" stroke="hsl(217, 91%, 60%)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Holdings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Symbol</th>
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Shares</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Avg Price</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Current</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Value</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">P&L</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Today</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const value = h.shares * h.currentPrice;
                  const pl = (h.currentPrice - h.avgPrice) * h.shares;
                  return (
                    <tr key={h.symbol} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-2 px-3 font-mono font-bold">{h.symbol}</td>
                      <td className="py-2 px-3">{h.name}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{h.shares}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{formatCurrency(h.avgPrice)}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{formatCurrency(h.currentPrice)}</td>
                      <td className="text-right py-2 px-3 tabular-nums font-medium">{formatCurrency(value)}</td>
                      <td className={`text-right py-2 px-3 tabular-nums font-medium ${pl >= 0 ? "text-accent" : "text-destructive"}`}>
                        {pl >= 0 ? "+" : ""}{formatCurrency(pl)}
                      </td>
                      <td className="text-right py-2 px-3">
                        <Badge variant={h.change >= 0 ? "default" : "destructive"} className="text-xs">
                          {h.change >= 0 ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                          {h.change >= 0 ? "+" : ""}{h.change}%
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
