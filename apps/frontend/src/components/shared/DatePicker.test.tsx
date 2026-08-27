// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import { enUS, nl } from "date-fns/locale";
import { DatePicker } from "./DatePicker";

const languageState = vi.hoisted(() => ({ value: "en" as "en" | "nl" }));
const dateFormatState = vi.hoisted(() => ({ value: "YYYY-MM-DD" }));

vi.mock("@/contexts/LanguageContext", () => ({
    useLanguage: () => ({
        language: languageState.value,
        t: (key: string, vars?: Record<string, string>) =>
            vars?.format ? `${key} ${vars.format}` : key,
    }),
}));

vi.mock("@/contexts/AppSettingsContext", () => ({
    useAppSettings: () => ({
        appSettings: {
            dateFormat: dateFormatState.value,
            startOfWeek: "monday",
        },
    }),
}));

describe("DatePicker calendar locale", () => {
    beforeEach(() => {
        languageState.value = "en";
        dateFormatState.value = "YYYY-MM-DD";
    });

    it.each([
        ["en", enUS, "Mo"],
        ["nl", nl, "ma"],
    ] as const)(
        "renders month and weekday labels in %s",
        (language, locale, weekday) => {
            languageState.value = language;
            render(
                <DatePicker value={new Date(2026, 2, 15)} onChange={vi.fn()} />,
            );

            fireEvent.click(screen.getByRole("button"));

            const caption = format(new Date(), "LLLL y", { locale });
            expect(screen.getByText(caption)).toBeInTheDocument();
            expect(screen.getAllByText(weekday).length).toBeGreaterThan(0);
        },
    );

    it("offers month/year jumps across the historical and future range", () => {
        render(<DatePicker value={new Date(2026, 2, 15)} onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole("button"));

        const year = screen.getByRole("combobox", { name: /year/i });
        const currentYear = new Date().getFullYear();
        expect(
            year.querySelector(`option[value="${currentYear - 100}"]`),
        ).toBeInTheDocument();
        expect(
            year.querySelector(`option[value="${currentYear + 20}"]`),
        ).toBeInTheDocument();
        expect(
            document.querySelectorAll("svg.lucide-chevron-down"),
        ).toHaveLength(2);

        fireEvent.change(year, { target: { value: "2019" } });
        expect(year).toHaveValue("2019");
        expect(
            screen.getByRole("combobox", { name: /month/i }),
        ).toBeInTheDocument();
    });

    it("expands the year dropdown to include an already-selected outlier", () => {
        render(<DatePicker value={new Date(1880, 5, 10)} onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole("button"));

        const year = screen.getByRole("combobox", { name: /year/i });
        expect(year.querySelector('option[value="1880"]')).toBeInTheDocument();
    });

    it("applies valid typed input on Enter without submitting a parent form", () => {
        const onChange = vi.fn();
        const onSubmit = vi.fn((event: React.FormEvent) =>
            event.preventDefault(),
        );
        render(
            <form onSubmit={onSubmit}>
                <DatePicker onChange={onChange} />
            </form>,
        );
        fireEvent.click(screen.getByRole("button"));

        const input = screen.getByRole("textbox", {
            name: /datePicker.inputLabel/i,
        });
        fireEvent.change(input, { target: { value: "2024-02-29" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(onSubmit).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toEqual(new Date(2024, 1, 29));
    });

    it("applies valid typed input on blur", () => {
        const onChange = vi.fn();
        render(<DatePicker onChange={onChange} />);
        fireEvent.click(screen.getByRole("button"));

        const input = screen.getByRole("textbox", {
            name: /datePicker.inputLabel/i,
        });
        fireEvent.change(input, { target: { value: "2026-03-24" } });
        fireEvent.blur(input);

        expect(onChange).toHaveBeenCalledWith(new Date(2026, 2, 24));
    });

    it("associates an invalid-format error and does not change the value", () => {
        const onChange = vi.fn();
        render(<DatePicker onChange={onChange} />);
        fireEvent.click(screen.getByRole("button"));

        const input = screen.getByRole("textbox", {
            name: /datePicker.inputLabel/i,
        });
        fireEvent.change(input, { target: { value: "2026-02-31" } });
        fireEvent.blur(input);

        expect(onChange).not.toHaveBeenCalled();
        expect(input).toHaveAttribute("aria-invalid", "true");
        const errorId = input.getAttribute("aria-describedby");
        expect(document.getElementById(errorId!)).toHaveTextContent(
            /datePicker.invalidFormat/,
        );
    });

    it("clears the typed draft and selected value through the existing clear action", () => {
        const onChange = vi.fn();
        render(
            <DatePicker
                value={new Date(2026, 2, 24)}
                onChange={onChange}
                allowClear
            />,
        );
        fireEvent.click(screen.getByRole("button"));
        fireEvent.click(screen.getByRole("button", { name: "common.clear" }));

        expect(onChange).toHaveBeenCalledWith(undefined);
        expect(
            screen.getByRole("textbox", { name: /datePicker.inputLabel/i }),
        ).toHaveValue("");
    });
});
