/**
 * Shared utilities for the Statistics page and its sub-components.
 */

import { formatDate, parseISO } from "@/components/shared/dateUtils";
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
    return formatDate(parseISO(`${period}-01`), "MMM yyyy");
  } catch {
    return period;
  }
}

export function formatPeriodShort(period: string): string {
  try {
    return formatDate(parseISO(`${period}-01`), "MMM yy");
  } catch {
    return period;
  }
}

export interface ExpandableGroupInput {
  general: string;
  children: ReadonlyArray<{ detailName: string }>;
}

// A group is expandable iff it has at least one child whose detailName
// differs from the parent general name. Flat categories produce a single
// self-child (detailName === general) and must not show a chevron.
export function isExpandableGroup(group: ExpandableGroupInput): boolean {
  return group.children.some((c) => c.detailName !== group.general);
}

export function computeMasterToggleState(
  expandableGroupNames: ReadonlyArray<string>,
  collapsedGroups: ReadonlySet<string>
): { hasExpandable: boolean; allCollapsed: boolean } {
  return {
    hasExpandable: expandableGroupNames.length > 0,
    allCollapsed:
      expandableGroupNames.length > 0 &&
      expandableGroupNames.every((g) => collapsedGroups.has(g)),
  };
}
