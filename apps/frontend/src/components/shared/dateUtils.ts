function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDate(date: Date, pattern: string, locale = "en-US"): string {
  const y = date.getFullYear();
  const M = date.getMonth() + 1;
  const d = date.getDate();
  const H = date.getHours();
  const min = date.getMinutes();
  const yy = String(y).slice(-2);
  const mm = pad2(M);
  const dd = pad2(d);
  const HH = pad2(H);
  const mm2 = pad2(min);
  const MMM = new Intl.DateTimeFormat(locale, { month: "short" }).format(date);

  switch (pattern) {
    case "yyyy-MM-dd":       return `${y}-${mm}-${dd}`;
    case "yyyy-MM-dd HH:mm": return `${y}-${mm}-${dd} ${HH}:${mm2}`;
    case "dd/MM/yyyy":       return `${dd}/${mm}/${y}`;
    case "MM/dd/yyyy":       return `${mm}/${dd}/${y}`;
    case "dd.MM.yyyy":       return `${dd}.${mm}.${y}`;
    case "dd-MM-yyyy":       return `${dd}-${mm}-${y}`;
    case "MMM yyyy":         return `${MMM} ${y}`;
    case "MMM yy":           return `${MMM} ${yy}`;
    case "MM/yyyy":          return `${mm}/${y}`;
    case "yyyy-MM":          return `${y}-${mm}`;
    case "MM.yyyy":          return `${mm}.${y}`;
    case "MM-yyyy":          return `${mm}-${y}`;
    case "dd MMM yyyy":      return `${dd} ${MMM} ${y}`;
    case "MMM d":            return `${MMM} ${d}`;
    default:
      return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
  }
}

export function parseISO(dateString: string): Date {
  // date-only strings (YYYY-MM-DD) must parse as local midnight, not UTC midnight,
  // to avoid off-by-one-day display for users east of UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const [y, m, d] = dateString.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(dateString);
}

export function differenceInDays(dateLeft: Date, dateRight: Date): number {
  return Math.floor((dateLeft.getTime() - dateRight.getTime()) / 86400000);
}

export function formatDistanceToNow(date: Date, _options?: { addSuffix?: boolean; locale?: string }): string {
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(_options?.locale ?? "en", { numeric: "auto" });

  if (absMs < 60_000) return rtf.format(Math.round(diffMs / 1000), "second");
  if (absMs < 3_600_000) return rtf.format(Math.round(diffMs / 60_000), "minute");
  if (absMs < 86_400_000) return rtf.format(Math.round(diffMs / 3_600_000), "hour");
  if (absMs < 86_400_000 * 30) return rtf.format(Math.round(diffMs / 86_400_000), "day");
  if (absMs < 86_400_000 * 365) return rtf.format(Math.round(diffMs / (86_400_000 * 30.44)), "month");
  return rtf.format(Math.round(diffMs / (86_400_000 * 365.25)), "year");
}

export function parseLocalDateFromYmd(dateStr: string): Date {
  if (typeof dateStr !== "string" || dateStr.length === 0) {
    return new Date(NaN);
  }
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

export function toYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function appDateFormatToDateFnsPattern(appDateFormat: string): string {
  switch (appDateFormat) {
    case "DD/MM/YYYY": return "dd/MM/yyyy";
    case "MM/DD/YYYY": return "MM/dd/yyyy";
    case "YYYY-MM-DD": return "yyyy-MM-dd";
    case "DD.MM.YYYY": return "dd.MM.yyyy";
    case "DD-MM-YYYY": return "dd-MM-yyyy";
    default:           return "PPP";
  }
}

export function formatDateWithAppSettings(date: Date, appDateFormat: string): string {
  return formatDate(date, appDateFormatToDateFnsPattern(appDateFormat));
}

export function formatMonthYearWithAppSettings(
  date: Date,
  appDateFormat: string,
  locale = "en-US"
): string {
  switch (appDateFormat) {
    case "DD/MM/YYYY":
    case "MM/DD/YYYY": return formatDate(date, "MM/yyyy");
    case "YYYY-MM-DD": return formatDate(date, "yyyy-MM");
    case "DD.MM.YYYY": return formatDate(date, "MM.yyyy");
    case "DD-MM-YYYY": return formatDate(date, "MM-yyyy");
    default:
      return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(date);
  }
}

export function formatMonthLabelWithLocale(
  date: Date,
  locale = "en-US",
  width: "short" | "long" = "short"
): string {
  return new Intl.DateTimeFormat(locale, { month: width }).format(date);
}

export function formatDateStringWithAppSettings(
  dateStr: string | undefined | null,
  appDateFormat: string
): string {
  if (!dateStr) return "";

  try {
    const ymdPart = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymdPart)) {
      return formatDateWithAppSettings(parseLocalDateFromYmd(ymdPart), appDateFormat);
    }

    if (dateStr.includes("T")) {
      const isoDate = new Date(dateStr);
      if (!Number.isNaN(isoDate.getTime())) {
        return formatDateWithAppSettings(isoDate, appDateFormat);
      }
    }

    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDateWithAppSettings(parsed, appDateFormat);
    }
  } catch {
    // ignore parse errors and fall through to original value
  }

  return dateStr;
}

export function formatDateTimeWithAppSettings(
  date: Date,
  appDateFormat: string,
  locale = "en-US"
): string {
  return `${formatDateWithAppSettings(date, appDateFormat)} ${date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function formatDateTimeStringWithAppSettings(
  dateStr: string | undefined | null,
  appDateFormat: string,
  locale = "en-US"
): string {
  if (!dateStr) return "";

  const dateOnly = formatDateStringWithAppSettings(dateStr, appDateFormat);
  const ymdPart = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(ymdPart)
    ? parseLocalDateFromYmd(ymdPart)
    : new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return dateOnly;
  }

  const timePart = parsed.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${dateOnly} ${timePart}`;
}

export function weekStartsOnFromSetting(startOfWeek: "monday" | "sunday" | undefined): 0 | 1 {
  return startOfWeek === "sunday" ? 0 : 1;
}
