export type PlannedDueDate =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "date"; date: Date };

export function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * Parse a planned-payment date as a local calendar day.
 *
 * The API normally returns YYYY-MM-DD, but older fixtures and clients may send
 * an ISO timestamp. Taking its date portion avoids the east-of-UTC day shift
 * caused by `new Date("YYYY-MM-DD")` while retaining the page's established
 * permissive numeric parsing behavior.
 */
export function parsePlannedDueDate(value?: string | null): PlannedDueDate {
  if (!value || typeof value !== "string") return { kind: "missing" };

  const datePart = value.includes("T") ? value.split("T")[0] : value;
  const [year, month, day] = datePart.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return { kind: "invalid" };
  }

  return { kind: "date", date: new Date(year, month - 1, day, 0, 0, 0, 0) };
}
