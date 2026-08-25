import React from "react";
import { LucideIcon } from "lucide-react";
import { StatCard } from "@/components/shared/StatCard";

export interface SummaryCardItem {
  title: string;
  /**
   * Display value. Currency amounts should be passed as a node
   * (`<RollingNumber parts={fmtParts(x)} />`) so the tile keeps the Money
   * micro-typography inside the odometer; plain strings (percentages, counts)
   * still get the odometer treatment from StatCard.
   */
  value: React.ReactNode;
  icon: LucideIcon;
  desc: React.ReactNode;
  cls: string;
}

function trendFromClass(cls: string): "income" | "expense" | "neutral" {
  if (cls.includes("gain")) return "income";
  if (cls.includes("loss")) return "expense";
  return "neutral";
}

interface TaxSummaryCardProps {
  cards: SummaryCardItem[];
}

export function TaxSummaryCard({ cards }: TaxSummaryCardProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((c) => (
        <StatCard
          key={c.title}
          title={c.title}
          value={c.value}
          icon={c.icon}
          trend={trendFromClass(c.cls)}
          valueClassName={c.cls}
          subtitle={c.desc}
        />
      ))}
    </div>
  );
}
