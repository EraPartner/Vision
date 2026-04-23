import { format } from "date-fns";

export function parseLocalDateFromYmd(dateStr: string): Date {
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
    case "DD/MM/YYYY":
      return "dd/MM/yyyy";
    case "MM/DD/YYYY":
      return "MM/dd/yyyy";
    case "YYYY-MM-DD":
      return "yyyy-MM-dd";
    case "DD.MM.YYYY":
      return "dd.MM.yyyy";
    case "DD-MM-YYYY":
      return "dd-MM-yyyy";
    default:
      return "PPP";
  }
}

export function formatDateWithAppSettings(date: Date, appDateFormat: string): string {
  return format(date, appDateFormatToDateFnsPattern(appDateFormat));
}

export function formatMonthYearWithAppSettings(
  date: Date,
  appDateFormat: string,
  locale: string = "en-US"
): string {
  switch (appDateFormat) {
    case "DD/MM/YYYY":
    case "MM/DD/YYYY":
      return format(date, "MM/yyyy");
    case "YYYY-MM-DD":
      return format(date, "yyyy-MM");
    case "DD.MM.YYYY":
      return format(date, "MM.yyyy");
    case "DD-MM-YYYY":
      return format(date, "MM-yyyy");
    default:
      return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(date);
  }
}

export function formatMonthLabelWithLocale(
  date: Date,
  locale: string = "en-US",
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
  locale: string = "en-US"
): string {
  return `${formatDateWithAppSettings(date, appDateFormat)} ${date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function formatDateTimeStringWithAppSettings(
  dateStr: string | undefined | null,
  appDateFormat: string,
  locale: string = "en-US"
): string {
  if (!dateStr) return "";

  const dateOnly = formatDateStringWithAppSettings(dateStr, appDateFormat);
  const ymdPart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
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
