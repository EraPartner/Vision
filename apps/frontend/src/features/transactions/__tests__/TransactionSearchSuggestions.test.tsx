// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { TransactionSearchSuggestions } from "../components/TransactionSearchSuggestions";

const settings = vi.hoisted(() => ({
    numberFormat: "us",
    defaultCurrency: "EUR",
}));
vi.mock("@/stores/hydration/AppSettingsHydration", async (original) => ({
    ...(await original<
        typeof import("@/stores/hydration/AppSettingsHydration")
    >()),
    useAppSettings: () => ({ appSettings: settings }),
}));
vi.mock("@/components/shared/DatePicker", () => ({
    DatePicker: ({
        value,
        onChange,
        placeholder,
        ...props
    }: {
        value?: Date;
        onChange: (date?: Date) => void;
        placeholder: string;
    }) => (
        <input
            aria-invalid={
                (props as Record<string, unknown>)["aria-invalid"] as
                    boolean | undefined
            }
            aria-describedby={
                (props as Record<string, unknown>)["aria-describedby"] as
                    string | undefined
            }
            type="date"
            aria-label={placeholder}
            value={
                value
                    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
                    : ""
            }
            onChange={(event) =>
                onChange(
                    event.target.value
                        ? new Date(`${event.target.value}T12:00:00`)
                        : undefined,
                )
            }
        />
    ),
}));

describe("TransactionSearchSuggestions", () => {
    beforeEach(() => {
        settings.numberFormat = "us";
    });

    it("parses localized signed decimal amounts", async () => {
        settings.numberFormat = "eu";
        const user = userEvent.setup();
        const onApply = vi.fn();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={vi.fn()}
            />,
        );
        await user.click(
            await screen.findByRole("button", { name: /Amount equals/i }),
        );
        await user.type(screen.getByRole("textbox"), "+1.234,56");
        await user.click(screen.getByRole("button", { name: /Apply/i }));
        expect(onApply).toHaveBeenCalledWith({
            amount_min: "1234.56",
            amount_max: "1234.56",
            amount_signed: "true",
        });
    });

    it("rejects an invalid nonblank range bound and preserves one-sided filters", async () => {
        const user = userEvent.setup();
        const onApply = vi.fn();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={vi.fn()}
            />,
        );
        await user.click(screen.getByRole("button", { name: /Amount from/i }));
        const [minimum, maximum] = screen.getAllByRole("textbox");
        await user.type(minimum, "abc");
        await user.type(maximum, "100");
        expect(screen.getByRole("alert")).toBeVisible();
        expect(minimum).toHaveAttribute("aria-invalid", "true");
        expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled();
        await user.keyboard("{Enter}");
        expect(onApply).not.toHaveBeenCalled();
        await user.clear(minimum);
        await user.click(screen.getByRole("button", { name: /Apply/i }));
        expect(onApply).toHaveBeenCalledWith({
            amount_min: undefined,
            amount_max: "100",
            amount_signed: undefined,
        });
    });

    it("rejects reversed dates and allows a one-sided date filter", async () => {
        const user = userEvent.setup();
        const onApply = vi.fn();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={vi.fn()}
            />,
        );
        await user.click(screen.getByRole("button", { name: /From date/i }));
        const from = screen.getByLabelText("From");
        const to = screen.getByLabelText("To");
        fireEvent.change(from, { target: { value: "2026-09-20" } });
        fireEvent.change(to, { target: { value: "2026-09-01" } });
        expect(screen.getByRole("alert")).toBeVisible();
        expect(from).toHaveAttribute("aria-invalid", "true");
        expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled();
        expect(onApply).not.toHaveBeenCalled();
        fireEvent.change(to, { target: { value: "" } });
        await user.click(screen.getByRole("button", { name: /Apply/i }));
        expect(onApply).toHaveBeenCalledWith({
            start_date: "2026-09-20",
            end_date: undefined,
        });
    });
    it("lists the income/expense quick filters and applies them", async () => {
        const onApply = vi.fn();
        const close = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={close}
            />,
        );

        expect(
            await screen.findByRole("button", { name: /All income/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /All expenses/i }),
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /All income/i }));
        expect(onApply).toHaveBeenCalledWith({ transaction_type: "income" });
        expect(close).toHaveBeenCalled();
    });

    it("applies a bare amount as a sign-agnostic magnitude match", async () => {
        const onApply = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={vi.fn()}
            />,
        );

        await user.click(
            await screen.findByRole("button", { name: /Amount equals/i }),
        );
        const input = await screen.findByRole("textbox");
        await user.type(input, "50");
        await user.click(screen.getByRole("button", { name: /Apply/i }));

        expect(onApply).toHaveBeenCalledWith({
            amount_min: "50",
            amount_max: "50",
            amount_signed: undefined,
        });
    });

    it("treats a +50 / -50 prefix as a signed exact match", async () => {
        const onApply = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={vi.fn()}
            />,
        );

        await user.click(
            await screen.findByRole("button", { name: /Amount equals/i }),
        );
        await user.type(await screen.findByRole("textbox"), "-50");
        await user.click(screen.getByRole("button", { name: /Apply/i }));

        expect(onApply).toHaveBeenCalledWith({
            amount_min: "-50",
            amount_max: "-50",
            amount_signed: "true",
        });
    });

    it("applies a full calendar year as a date range", async () => {
        const onApply = vi.fn();
        const user = userEvent.setup();
        const year = new Date().getFullYear();
        renderWithApp(
            <TransactionSearchSuggestions
                query=""
                onApply={onApply}
                close={vi.fn()}
            />,
        );

        await user.click(
            await screen.findByRole("button", {
                name: new RegExp(`Transactions of ${year}`),
            }),
        );
        expect(onApply).toHaveBeenCalledWith({
            start_date: `${year}-01-01`,
            end_date: `${year}-12-31`,
        });
    });
});
