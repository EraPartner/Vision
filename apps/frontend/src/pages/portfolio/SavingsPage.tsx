import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PiggyBank, Shield } from "lucide-react";

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "EUR", minimumFractionDigits: 2,
  }).format(val);
}

const accounts = [
  { name: "Emergency Fund", type: "Savings", balance: 5000, interestRate: 2.1, maturityDate: null },
  { name: "Belgian Gov Bond 2028", type: "Bond", balance: 3500, interestRate: 3.2, maturityDate: "2028-06-15" },
  { name: "Term Deposit 12M", type: "Fixed Deposit", balance: 3280, interestRate: 3.8, maturityDate: "2026-09-01" },
];

export default function SavingsPage() {
  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);
  const weightedRate = accounts.reduce((s, a) => s + a.interestRate * a.balance, 0) / totalBalance;
  const annualInterest = totalBalance * (weightedRate / 100);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Savings & Bonds</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Balance</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{formatCurrency(totalBalance)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Avg Interest Rate</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-accent">{weightedRate.toFixed(2)}%</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Annual Interest</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-accent">+{formatCurrency(annualInterest)}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Accounts</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4">
            {accounts.map((a) => (
              <div key={a.name} className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    {a.type === "Savings" ? <PiggyBank className="h-5 w-5 text-primary" /> : <Shield className="h-5 w-5 text-primary" />}
                  </div>
                  <div>
                    <p className="font-medium">{a.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs">{a.type}</Badge>
                      {a.maturityDate && (
                        <span className="text-xs text-muted-foreground">Matures: {a.maturityDate}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold tabular-nums">{formatCurrency(a.balance)}</p>
                  <p className="text-xs text-accent">{a.interestRate}% p.a.</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
