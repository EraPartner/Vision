/**
 * Shared utilities for the Statistics page and its sub-components.
 */

import { format, parseISO } from "date-fns";
import type { WidgetDefinition } from "@/hooks/useWidgetVisibility";

export type PivotValueMode = "absolute" | "net" | "income" | "expense";

export const STATISTICS_WIDGETS: Array<WidgetDefinition & { labelKey?: string }> = [
  { id: "summaryCards",     labelKey: "statsPage.widget.summaryCards",     defaultVisible: true },
  { id: "monthly",          labelKey: "statsPage.widget.monthly",          defaultVisible: true },
  { id: "netTrend",         labelKey: "statsPage.widget.netTrend",         defaultVisible: true },
  { id: "categoryPie",      labelKey: "statsPage.widget.categoryPie",      defaultVisible: true },
  { id: "categoryTrend",    labelKey: "statsPage.widget.categoryTrend",    defaultVisible: true },
  { id: "pivotTable",       labelKey: "statsPage.widget.pivotTable",       defaultVisible: true },
  { id: "topRecipients",    labelKey: "statsPage.widget.topRecipients",    defaultVisible: true },
  { id: "yearlyComparison", labelKey: "statsPage.widget.yearlyComparison", defaultVisible: true },
  { id: "yearlySummary",    labelKey: "statsPage.widget.yearlySummary",    defaultVisible: true },
];

export function formatPeriodLabel(period: string): string {
  try {
    return format(parseISO(`${period}-01`), "MMM yyyy");
  } catch {
    return period;
  }
}

export function formatPeriodShort(period: string): string {
  try {
    return format(parseISO(`${period}-01`), "MMM yy");
  } catch {
    return period;
  }
}
