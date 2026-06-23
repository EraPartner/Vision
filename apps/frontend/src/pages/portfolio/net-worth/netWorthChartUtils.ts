import { formatDateWithAppSettings, parseLocalDateFromYmd } from "@/components/shared/dateUtils";

export type NetWorthSnapshot = {
  date: string;
  netWorth: number;
  liquid: number;
  liabilities: number;
  investments: number;
};

export const EMPTY_SNAPSHOTS: NetWorthSnapshot[] = [];

export function normalizeYmd(value: string): string {
  if (!value) return value;
  if (value.includes('T')) return value.split('T')[0];
  if (value.length > 10) return value.slice(0, 10);
  return value;
}

export function fmtDay(date: string, appDateFormat: string): string {
  return formatDateWithAppSettings(parseLocalDateFromYmd(date), appDateFormat);
}
