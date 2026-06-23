import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface SummaryCardItem {
  title: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: React.ReactNode;
  cls: string;
}

interface TaxSummaryCardProps {
  cards: SummaryCardItem[];
}

export function TaxSummaryCard({ cards }: TaxSummaryCardProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((c) => (
        <Card key={c.title} className="glass-regular premium-frame">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
            <c.icon className={`h-4 w-4 ${c.cls}`} />
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${c.cls}`}>{c.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{c.desc}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
