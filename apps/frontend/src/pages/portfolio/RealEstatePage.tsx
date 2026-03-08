import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2 } from "lucide-react";

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "EUR", minimumFractionDigits: 0,
  }).format(val);
}

const properties = [
  { name: "City Apartment", location: "Brussels, BE", purchasePrice: 185000, currentValue: 210000, monthlyRent: 950, type: "Rental" },
  { name: "Studio Downtown", location: "Antwerp, BE", purchasePrice: 125000, currentValue: 138000, monthlyRent: 680, type: "Rental" },
];

export default function RealEstatePage() {
  const totalValue = properties.reduce((s, p) => s + p.currentValue, 0);
  const totalCost = properties.reduce((s, p) => s + p.purchasePrice, 0);
  const monthlyIncome = properties.reduce((s, p) => s + p.monthlyRent, 0);
  const annualYield = (monthlyIncome * 12) / totalValue * 100;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Real Estate</h1>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Value</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{formatCurrency(totalValue)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Appreciation</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent">+{formatCurrency(totalValue - totalCost)}</p>
            <p className="text-xs text-muted-foreground mt-1">+{((totalValue - totalCost) / totalCost * 100).toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Monthly Income</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-accent">{formatCurrency(monthlyIncome)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Annual Yield</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-foreground">{annualYield.toFixed(1)}%</p></CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {properties.map((p) => {
          const gain = p.currentValue - p.purchasePrice;
          return (
            <Card key={p.name}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Building2 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{p.name}</CardTitle>
                      <CardDescription>{p.location}</CardDescription>
                    </div>
                  </div>
                  <Badge>{p.type}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Purchase Price</p>
                    <p className="font-medium tabular-nums">{formatCurrency(p.purchasePrice)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Current Value</p>
                    <p className="font-medium tabular-nums">{formatCurrency(p.currentValue)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Monthly Rent</p>
                    <p className="font-medium tabular-nums text-accent">{formatCurrency(p.monthlyRent)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Capital Gain</p>
                    <p className={`font-medium tabular-nums ${gain >= 0 ? "text-accent" : "text-destructive"}`}>
                      {gain >= 0 ? "+" : ""}{formatCurrency(gain)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
