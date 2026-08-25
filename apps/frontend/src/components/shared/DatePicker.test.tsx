// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import { enUS, nl } from "date-fns/locale";
import { DatePicker } from "./DatePicker";

const languageState = vi.hoisted(() => ({ value: "en" as "en" | "nl" }));

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({
    language: languageState.value,
    t: (key: string) => key,
  }),
}));

vi.mock("@/contexts/AppSettingsContext", () => ({
  useAppSettings: () => ({
    appSettings: { dateFormat: "YYYY-MM-DD", startOfWeek: "monday" },
  }),
}));

describe("DatePicker calendar locale", () => {
  beforeEach(() => {
    languageState.value = "en";
  });

  it.each([
    ["en", enUS, "Mo"],
    ["nl", nl, "ma"],
  ] as const)("renders month and weekday labels in %s", (language, locale, weekday) => {
    languageState.value = language;
    render(<DatePicker value={new Date(2026, 2, 15)} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button"));

    const caption = format(new Date(), "LLLL y", { locale });
    expect(screen.getByText(caption)).toBeInTheDocument();
    expect(screen.getAllByText(weekday).length).toBeGreaterThan(0);
  });
});
