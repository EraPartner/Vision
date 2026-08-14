/**
 * Shared utilities for the Statistics page and its sub-components.
 */

import { formatDate, parseISO } from "@/components/shared/dateUtils";
import type { WidgetDefinition } from "@/hooks/useWidgetVisibility";

export type PivotValueMode = "absolute" | "net" | "income" | "expense";

export const STATISTICS_WIDGETS: Array<WidgetDefinition & { labelKey: string }> = [
  // id kept as "summaryCards" on purpose: it is the persisted key in the
  // widget_visibility setting, so renaming it would silently un-hide the page
  // opening for anyone who had hidden it. The widget itself is MonthlyRhythm.
  { id: "summaryCards",     labelKey: "statsPage.widget.monthlyRhythm",    defaultVisible: true },
  { id: "monthly",          labelKey: "statsPage.widget.monthly",          defaultVisible: true },
  { id: "netTrend",         labelKey: "statsPage.widget.netTrend",         defaultVisible: true },
  { id: "categoryPie",      labelKey: "statsPage.widget.categoryPie",      defaultVisible: true },
  { id: "categoryTrend",    labelKey: "statsPage.widget.categoryTrend",    defaultVisible: true },
  { id: "pivotTable",       labelKey: "statsPage.widget.pivotTable",       defaultVisible: true },
  { id: "topRecipients",    labelKey: "statsPage.widget.topRecipients",    defaultVisible: true },
  { id: "yearlyComparison", labelKey: "statsPage.widget.yearlyComparison", defaultVisible: true },
  { id: "yearlySummary",    labelKey: "statsPage.widget.yearlySummary",    defaultVisible: true },
];

/**
 * `locale` is required, not defaulted: these render month *names*, and every
 * caller that silently omitted it printed English months in the Dutch UI. Pass
 * `appLanguageToLocale(language)` from the component.
 */
export function formatPeriodLabel(period: string, locale: string): string {
  try {
    return formatDate(parseISO(`${period}-01`), "MMM yyyy", locale);
  } catch {
    return period;
  }
}

export function formatPeriodShort(period: string, locale: string): string {
  try {
    return formatDate(parseISO(`${period}-01`), "MMM yy", locale);
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
