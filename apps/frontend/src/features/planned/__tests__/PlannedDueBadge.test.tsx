// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlannedDueBadge } from "@/features/planned/PlannedDueBadge";
import { parsePlannedDueDate } from "@/features/planned/plannedDueDate";

const translations = vi.hoisted<Record<string, string>>(() => ({
  "plannedPage.due.noDate": "No date",
  "plannedPage.due.invalid": "Invalid date",
  "plannedPage.due.overdue": "Overdue",
  "plannedPage.due.today": "Today",
  "plannedPage.due.tomorrow": "Tomorrow",
  "plannedPage.due.inDays": "In {n}d",
}));

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const template = translations[key] ?? key;
      return Object.entries(params ?? {}).reduce(
        (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
        template,
      );
    },
  }),
}));

const TODAY = new Date(2026, 7, 14, 14, 0, 0, 0);

function renderBadge(dueDate?: string | null) {
  return render(<PlannedDueBadge dueDate={dueDate} dateFormat="YYYY-MM-DD" today={TODAY} />);
}

describe("PlannedDueBadge", () => {
  it.each([
    [undefined, "No date"],
    ["not-a-date", "Invalid date"],
    ["2026-08-13", "Overdue"],
    ["2026-08-14", "Today"],
    ["2026-08-15", "Tomorrow"],
    ["2026-08-18", "In 4d"],
    ["2026-09-01", "2026-09-01"],
  ])("renders %s as %s", (dueDate, expected) => {
    renderBadge(dueDate);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("takes the date part of an ISO timestamp without shifting calendar day", () => {
    const parsed = parsePlannedDueDate("2026-08-15T00:00:00.000Z");
    expect(parsed.kind).toBe("date");
    if (parsed.kind === "date") {
      expect(parsed.date.getFullYear()).toBe(2026);
      expect(parsed.date.getMonth()).toBe(7);
      expect(parsed.date.getDate()).toBe(15);
      expect(parsed.date.getHours()).toBe(0);
    }
  });
});
