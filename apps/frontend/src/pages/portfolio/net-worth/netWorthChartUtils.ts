import { formatDateWithAppSettings, parseLocalDateFromYmd } from "@/components/shared/dateUtils";

export type NetWorthSeries = 'netWorth' | 'liquid' | 'investments';

export type NetWorthSnapshot = {
  date: string;
  netWorth: number;
  liquid: number;
  investments: number;
};

export const EMPTY_SNAPSHOTS: NetWorthSnapshot[] = [];

export const DAY_WIDTH_OPTIONS = [
  20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1, 0.75, 0.5, 0.25, 0.15, 0.1, 0.05, 0.03,
] as const;

export const MIN_CHART_WIDTH = 320;
export const DOMAIN_SCROLL_THRESHOLD_PX = 24;
export const DOMAIN_SCROLL_IDLE_MS = 120;

export function normalizeYmd(value: string): string {
  if (!value) return value;
  if (value.includes('T')) return value.split('T')[0];
  if (value.length > 10) return value.slice(0, 10);
  return value;
}

export function fmtDay(date: string, appDateFormat: string): string {
  return formatDateWithAppSettings(parseLocalDateFromYmd(date), appDateFormat);
}

/**
 * Decimate a tick array so that labels fit within chartWidth without overlap.
 *
 * Pure function: given a chart width and desired minimum pixel budget per label,
 * keep every Nth tick. The first and last tick are always preserved so the
 * chart's domain boundaries remain labelled.
 *
 * @param ticks Candidate tick values (already in desired order).
 * @param chartWidth Available horizontal pixel budget for axis labels.
 * @param minLabelPx Minimum pixels allocated per rendered label.
 * @returns A subset of the input ticks.
 */
export function decimateTicks<T>(ticks: readonly T[], chartWidth: number, minLabelPx = 60): T[] {
  if (ticks.length <= 2) return [...ticks];
  const safeWidth = Math.max(1, chartWidth);
  const safeMinLabelPx = Math.max(1, minLabelPx);
  const maxLabels = Math.max(1, Math.floor(safeWidth / safeMinLabelPx));
  if (ticks.length <= maxLabels) return [...ticks];

  const stride = Math.max(1, Math.ceil(ticks.length / maxLabels));
  const result: T[] = [];
  for (let i = 0; i < ticks.length; i += stride) {
    result.push(ticks[i]);
  }
  const lastTick = ticks[ticks.length - 1];
  if (result[result.length - 1] !== lastTick) {
    result.push(lastTick);
  }
  return result;
}

export function formatMonthTickLabel(dateYmd: string, formatter: Intl.DateTimeFormat): string {
  const normalized = normalizeYmd(dateYmd);
  const parsed = parseLocalDateFromYmd(normalized);
  if (Number.isNaN(parsed.getTime())) return normalized;
  return formatter.format(parsed);
}

export function computeYDomain(
  points: NetWorthSnapshot[],
  series: NetWorthSeries[] = ['netWorth', 'liquid', 'investments'],
): [number, number] {
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    for (let j = 0; j < series.length; j++) {
      const value = point[series[j]];
      if (Number.isFinite(value)) {
        if (value < minValue) minValue = value;
        if (value > maxValue) maxValue = value;
      }
    }
  }

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return [0, 100];

  const span = maxValue - minValue;
  const padding = span === 0
    ? Math.max(Math.abs(maxValue) * 0.03, 1)
    : Math.max(span * 0.03, 1);

  const lower = Math.floor((minValue - padding) * 100) / 100;
  const upper = Math.ceil((maxValue + padding) * 100) / 100;
  return [lower, upper];
}

export function computeSeriesDomainForRange(
  points: NetWorthSnapshot[],
  series: NetWorthSeries,
  startIndex: number,
  endIndex: number,
): [number, number] {
  if (points.length === 0) return [0, 100];
  const safeStart = Math.max(0, startIndex);
  const safeEnd = Math.min(points.length - 1, endIndex);
  if (safeEnd < safeStart) return [0, 100];

  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let index = safeStart; index <= safeEnd; index += 1) {
    const value = points[index]?.[series];
    if (!Number.isFinite(value)) continue;
    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;
  }

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return [0, 100];

  const span = maxValue - minValue;
  const padding = span === 0
    ? Math.max(Math.abs(maxValue) * 0.03, 1)
    : Math.max(span * 0.03, 1);

  const lower = Math.floor((minValue - padding) * 100) / 100;
  const upper = Math.ceil((maxValue + padding) * 100) / 100;
  return [lower, upper];
}

function niceStep(roughStep: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 100;

  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;

  let niceNormalized: number;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;

  return niceNormalized * magnitude;
}

export function computeNiceYDomain(domain: [number, number], tickCount = 7): [number, number] {
  const [rawMin, rawMax] = domain;
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return [0, 1000];

  if (rawMin === rawMax) {
    const base = Math.max(100, niceStep(Math.abs(rawMax) / 5));
    const center = rawMax;
    const min = Math.floor((center - base * 2) / base) * base;
    const max = Math.ceil((center + base * 2) / base) * base;
    return min >= max ? [0, Math.max(base, max)] : [min, max];
  }

  const steps = Math.max(2, tickCount - 1);
  const roughStep = (rawMax - rawMin) / steps;
  const step = Math.max(1, niceStep(roughStep));
  const min = Math.floor(rawMin / step) * step;
  const max = Math.ceil(rawMax / step) * step;

  return min >= max ? [0, Math.max(step, max)] : [min, max];
}
