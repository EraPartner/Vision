/**
 * Shared page catalog for the e2e page-sweep specs.
 *
 * `a11y.spec.ts` (axe scans) and `network-drift.spec.ts` (failed-response
 * listener) both walk the same set of top-level pages. This is the single source
 * of truth for that list. `network-drift` additionally sweeps the Tax page (see
 * that spec).
 */
export interface PageEntry {
    name: string;
    path: string;
    heading: RegExp;
}

export const PAGES: PageEntry[] = [
    { name: "Dashboard", path: "/", heading: /^(dashboard|good (morning|afternoon|evening))/i },
    { name: "Transactions", path: "/transactions", heading: /^transactions$/i },
    { name: "Categories", path: "/categories", heading: /categories/i },
    { name: "Recipients", path: "/recipients", heading: /recipients/i },
    { name: "Statistics", path: "/statistics", heading: /statistics|analytics/i },
    { name: "Owes", path: "/owes", heading: /who owes/i },
    { name: "PortfolioOverview", path: "/portfolio", heading: /portfolio/i },
    { name: "Watchlist", path: "/portfolio/watchlist", heading: /watchlist/i },
    { name: "Planned", path: "/planned", heading: /planned payments/i },
];
