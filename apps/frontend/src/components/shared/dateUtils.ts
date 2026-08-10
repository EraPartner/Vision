import { format as dateFnsFormat, parseISO as dateFnsParseISO } from "date-fns";

/**
 * Map the app language to the locale used for month/day *names*.
 *
 * Deliberately separate from `numberFormatToLocale`: that maps the
 * number-format setting ('eu' -> 'de-DE') and would yield German month names.
 * Month names follow the UI language, number shapes follow the number setting.
 *
 * Previously copy-pasted inline in four chart components; centralised here so
 * the charts that still omit it have one obvious thing to reach for.
 */
export function appLanguageToLocale(language: string): string {
  return language === "nl" ? "nl-NL" : "en-US";
}

export function formatDate(date: Date, pattern: string, locale = "en-US"): string {
  switch (pattern) {
    // Numeric-only patterns delegate to date-fns; the tokens are locale-free.
    case "yyyy-MM-dd":
    case "yyyy-MM-dd HH:mm":
    case "dd/MM/yyyy":
    case "MM/dd/yyyy":
    case "dd.MM.yyyy":
    case "dd-MM-yyyy":
    case "MM/yyyy":
    case "yyyy-MM":
    case "MM.yyyy":
    case "MM-yyyy":
      return dateFnsFormat(date, pattern);
    default:
      break;
  }

  // Month-name patterns stay on Intl.DateTimeFormat: it honors the app locale,
  // while date-fns `format` uses its own locale objects (default enUS) and
  // would silently break non-English month rendering.
  const y = date.getFullYear();
  const MMM = pattern.includes("MMM")
    ? new Intl.DateTimeFormat(locale, { month: "short" }).format(date)
    : "";

  switch (pattern) {
    case "MMM yyyy":    return `${MMM} ${y}`;
    case "MMM yy":      return `${MMM} ${String(y).slice(-2)}`;
    case "dd MMM yyyy": return `${String(date.getDate()).padStart(2, "0")} ${MMM} ${y}`;
    case "MMM d":       return `${MMM} ${date.getDate()}`;
    default:
      return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
  }
}

export function parseISO(dateString: string): Date {
  // date-only strings (YYYY-MM-DD) must parse as local midnight, not UTC midnight,
  // to avoid off-by-one-day display for users east of UTC. date-fns parseISO
  // returns exactly that for date-only input (and, unlike the old hand-rolled
  // `new Date(y, m-1, d)`, rejects out-of-range days instead of rolling over).
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return dateFnsParseISO(dateString);
  }
  // Non-date-only input keeps Date's native parsing: date-fns is stricter on
  // malformed timestamps and this fallback must stay tolerant.
  return new Date(dateString);
}

export function differenceInDays(dateLeft: Date, dateRight: Date): number {
  const utcLeft = Date.UTC(dateLeft.getFullYear(), dateLeft.getMonth(), dateLeft.getDate());
  const utcRight = Date.UTC(dateRight.getFullYear(), dateRight.getMonth(), dateRight.getDate());
  return Math.round((utcLeft - utcRight) / 86400000);
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
  // Defensive: accept an ISO-timestamp wire value by taking its date part.
  // "2026-07-01T00:00:00.000Z".split("-") used to yield day NaN → Invalid
  // Date → consumers silently skipped every row (flat-zero sparkline,
  // "NaN days remaining"). The backend now sends plain Y-M-D for date-only
  // columns, but a raw timestamp must degrade to its calendar day, not NaN.
  const ymdPart = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
  const [year, month, day] = ymdPart.split("-").map(Number);
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
