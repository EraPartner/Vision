import { todayAppDateString, firstOfMonthYmd } from "../../lib/timezone.ts";
import type { Period } from "./dataFetcherPortfolio.ts";

/** Convert a Period to a concrete { startDate, endDate } range (ISO date strings). */
export function periodToDateRange(period: Period): {
  startDate: string;
  endDate: string;
} {
  // All boundaries derive from the APP_TIMEZONE calendar day via pure string
  // math — local-Date + toISOString() shifted rolling starts to the last day
  // of the previous month in UTC+ zones.
  const today = todayAppDateString();
  const year = Number(today.slice(0, 4));

  switch (period.kind) {
    case "ytd":
      return { startDate: `${year}-01-01`, endDate: today };
    case "rolling":
      return {
        startDate: firstOfMonthYmd(today, -(period.months - 1)),
        endDate: today,
      };
    case "custom":
      return { startDate: period.from, endDate: period.to };
    case "year":
      return {
        startDate: `${period.year}-01-01`,
        endDate: `${period.year}-12-31`,
      };
    default:
      return { startDate: `${year - 1}-01-01`, endDate: today };
  }
}
