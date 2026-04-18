---
title: ADR-018 visx/d3 Chart Migration from Recharts
type: adr
status: Accepted
date: 2026-04-17
tags: [adr, charting, frontend, migration, visx, d3, phase-9]
description: Migration from Recharts to visx + d3 for low-level chart primitives, enabling design-token-aware styling and tighter integration with liquid-glass aesthetic
aliases: [adr-018, visx migration, chart primitives, d3 charts]
---

# ADR-018: visx/d3 Chart Migration from Recharts

## Status
Accepted

## Date
2026-04-17

## Context

Vision frontend previously relied on Recharts for all chart rendering (monthly trend, category breakdown, portfolio performance, etc.). Recharts provides good defaults but:

1. **Styling constraints**: No native support for design tokens; color customization required prop-drilling or CSS-in-JS workarounds
2. **Bundle bloat**: Recharts adds ~50kb gzipped; visx/d3 offers granular imports (~15-20kb for typical chart suite)
3. **Aesthetic alignment**: Recharts presets do not align with liquid-glass aesthetic (emerald + gold palette, subtle grain, glass surface integration)
4. **Control mismatch**: Premade responsiveness and zoom handlers make bespoke interactions harder to implement

The liquid-glass design system rewrite ([[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017]]) required charts that could consume design tokens directly and render with full visual cohesion.

## Decision

### 1. Chart Primitive Library

Migrate to **visx** (Visx: Low-Level Visualization Primitives) + **d3** for chart composition:

- **visx**: Provides low-level React components (Axis, Line, Area, Bar, Pie, Group, etc.) with minimal styling assumptions
- **d3**: Scales (ScaleLinear, ScaleTime, etc.), shape generators (area, line, pie), utilities (extent, ascending, etc.)
- **Custom primitives**: Build high-level chart components in `src/components/charts/` that wrap visx + d3 with Vision design tokens

### 2. Chart Primitives Library

**Location**: `apps/frontend/src/components/charts/`

| Component | Purpose | Consumers |
|-----------|---------|-----------|
| `AreaChart.tsx` | Time-series area stacks | DashboardPage, StatisticsPage |
| `BarChart.tsx` | Category/recipient breakdown | StatisticsPage, DashboardPage |
| `StackedBarChart.tsx` | Multi-series bar stacks (by-month, by-category) | StatisticsPage, PerformancePage |
| `PieChart.tsx` | Category distribution (donut style) | StatisticsPage, DashboardPage |
| `DonutChart.tsx` | Segmented distribution with legend | StatisticsPage |
| `LineChart.tsx` | Multi-line trends | PerformancePage, WatchlistPage |
| `Sparkline.tsx` | Mini inline sparklines for cards | StatCard, MetricsCard |
| `Candlestick.tsx` | OHLC price action (Stocks, Crypto) | StocksPage, CryptoPage |
| `TreemapChart.tsx` | Hierarchical category spending | StatisticsPage |
| `ChartTooltip.tsx` | Shared tooltip renderer | All charts |
| `ChartLegend.tsx` | Shared legend component | Charts supporting multiple series |
| `ChartAxis.tsx` | Shared axis renderer (x, y) | All 2D charts |

### 3. Token Integration

All chart primitives consume design tokens from `apps/frontend/src/styles/tokens.css`:

- **Color palette**: Emerald + gold + supporting hues mapped to categorical palettes
- **Typography**: Fraunces for chart labels (sparingly), Inter Tight for legends/tooltips
- **Spacing**: Clamp-based responsive margins inherited from token system
- **Reduced motion**: ChartTooltip + animations check `useReducedMotion()` and skip enter/exit effects if needed

### 4. Migration Path

**Phase 1 (Immediate)**:
- Implement core chart primitives (Area, Bar, Pie, Line, Sparkline, CandleStick)
- Rewrite StatisticsPage, DashboardPage chart sections
- Verify data accuracy against Recharts originals (golden-fixture regression tests optional)

**Phase 2 (Follow-up)**:
- Rewrite PerformancePage chart sections
- Rewrite WatchlistPage market chart
- Update all dynamic chart consumers in portfolio pages

**Phase 3 (Polish)**:
- Add interactivity (zoom, pan, crosshair) where appropriate
- Optimize for large datasets (>5000 points) via LTTB downsampling on backend ([[docs/adr/008-performance-page-server-computed-response|ADR-008]])

### 5. Dependency Footprint

**Existing packages** (no new major deps):
- `visx` is already available via `visx/xy-chart`, `visx/shape`, `visx/axis`, `visx/legend`, `visx/tooltip` (incremental cost ~15kb gzipped)
- `d3` (core utilities only): `d3-scale`, `d3-shape`, `d3-array` (already pinned in lock file)

**Removed**:
- `recharts` (saves ~50kb gzipped)

## Consequences

### Positive

- **Token-native styling**: Charts inherit design tokens without prop-drilling; color changes propagate globally
- **Bundle savings**: Recharts (~50kb) → visx (~15kb) = ~35kb gzip reduction
- **Design cohesion**: Charts visually align with liquid-glass aesthetic (emerald + gold, glass surfaces, grain texture)
- **Control & flexibility**: Minimal abstraction allows bespoke interactivity (zoom, pan, crosshair) without fighting defaults
- **Performance**: No Recharts overhead; d3 scales + shape generators are battle-tested
- **Learning curve**: visx + d3 are lower-level → API surface is smaller, less magic

### Neutral

- **Implementation effort**: Requires rewriting each chart consumer; no bulk drop-in replacement
- **Testing complexity**: Chart rendering logic now lives in Vision codebase (property-testing or snapshot tests recommended)

### Negative

- **Accessibility challenge**: visx provides low-level building blocks; tooltip, legend, color-blind mode must be explicit
- **Animation complexity**: Recharts animations were built-in; visx + d3 animation requires Framer Motion or react-spring integration
- **Mobile interaction**: Pan/zoom on mobile requires touch-event handling (not automatic)

## Implementation Notes

### Accessibility

- All charts must include `role="img"` + `aria-label` describing overall chart purpose
- Tooltips and legends must be keyboard-accessible (arrow keys, tab navigation)
- Color-blind palettes should be provided (deuteranopia, protanopia fallbacks)

### Animation

Use Framer Motion for chart enter/exit animations (when `prefers-reduced-motion` is false):
- Initial mount: Stagger bars/areas with 50-100ms delay
- Exit: Fade to transparent, optional scale-down
- Data updates: Smoothly transition existing points, fade in new ones

### Responsive

Charts use `useWindowSize()` or container-query approach:
- Responsive margin adjustment via clamp-based token spacing
- Auto-adjust font size for axis labels on small screens
- Maintain consistent aspect ratio via SVG viewBox

## Verification

- **Build**: `bun run build` completes successfully
- **Type check**: `bunx tsc --noEmit` (zero errors)
- **Lint**: `bun run lint` (no new warnings)
- **Visual regression**: Smoke test across 5 breakpoints, both themes
- **Data accuracy**: Spot-check totals and trends match legacy Recharts

## Related

- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/008-performance-page-server-computed-response|ADR-008: Performance Page Server-Computed Response]]
- [[docs/performance/chart-downsampling|Chart Downsampling (LTTB)]]
- [[docs/components/ui-components|UI Components]]
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/features/statistics|Statistics Feature]]
