import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "EUR", minimumFractionDigits: 2,
  }).format(val);
}

const holdings = [
  { symbol: "BTC", name: "Bitcoin", amount: 0.35, avgPrice: 38500, currentPrice: 52100, change: 3.2 },
  { symbol: "ETH", name: "Ethereum", amount: 4.2, avgPrice: 2200, currentPrice: 2850, change: -1.4 },
  { symbol: "SOL", name: "Solana", amount: 50, avgPrice: 85, currentPrice: 142, change: 5.1 },
];

const chartData = [
  { month: "Jan", value: 18200 }, { month: "Feb", value: 19800 }, { month: "Mar", value: 21500 },
  { month: "Apr", value: 20100 }, { month: "May", value: 22800 }, { month: "Jun", value: 24300 },
];

export default function CryptoPage() {
  const totalValue = holdings.reduce((s, h) => s + h.amount * h.currentPrice, 0);
  const totalCost = holdings.reduce((s, h) => s + h.amount * h.avgPrice, 0);
  const totalGain = totalValue - totalCost;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Cryptocurrency</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Value</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{formatCurrency(totalValue)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Gain/Loss</CardTitle></CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalGain >= 0 ? "text-accent" : "text-destructive"}`}>
              {totalGain >= 0 ? "+" : ""}{formatCurrency(totalGain)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Assets</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-foreground">{holdings.length}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Performance</CardTitle><CardDescription>Crypto portfolio over time</CardDescription></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
              <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }} formatter={(v: number) => formatCurrency(v)} />
              <defs>
                <linearGradient id="cryptoGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(45, 93%, 47%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(45, 93%, 47%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="value" stroke="hsl(45, 93%, 47%)" fill="url(#cryptoGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Holdings</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Asset</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Amount</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Avg Price</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Current</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Value</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">24h</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.symbol} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className="py-2 px-3"><span className="font-mono font-bold">{h.symbol}</span> <span className="text-muted-foreground">{h.name}</span></td>
                    <td className="text-right py-2 px-3 tabular-nums">{h.amount}</td>
                    <td className="text-right py-2 px-3 tabular-nums">{formatCurrency(h.avgPrice)}</td>
                    <td className="text-right py-2 px-3 tabular-nums">{formatCurrency(h.currentPrice)}</td>
                    <td className="text-right py-2 px-3 tabular-nums font-medium">{formatCurrency(h.amount * h.currentPrice)}</td>
                    <td className="text-right py-2 px-3">
                      <Badge variant={h.change >= 0 ? "default" : "destructive"} className="text-xs">
                        {h.change >= 0 ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                        {h.change >= 0 ? "+" : ""}{h.change}%
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
