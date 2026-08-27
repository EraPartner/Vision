// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "@/components/ui/sonner";

vi.mock("@/contexts/ThemeContext", () => ({
    useTheme: () => ({ mode: "system" }),
}));

beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    });
});

afterEach(() => toast.dismiss());

describe("Toaster", () => {
    it("pins the documented Alt+T focus hotkey", () => {
        const {container} = render(<Toaster />);

        expect(container.querySelector("section")).toHaveAccessibleName(/alt\+t/i);
    });

    it("routes ordinary feedback to polite announcements and errors to assertive announcements", async () => {
        const {container} = render(<Toaster />);
        const polite = container.querySelector<HTMLElement>('[aria-live="polite"]');
        const assertive = container.querySelector<HTMLElement>('[aria-live="assertive"]');

        act(() => {
            toast.success("Saved", {description: "Account updated"});
            toast.error("Import failed", {description: "Check the CSV"});
        });

        await waitFor(() => {
            expect(polite).toHaveTextContent("Saved Account updated");
            expect(assertive).toHaveTextContent("Import failed Check the CSV");
        });
        expect(polite).not.toHaveTextContent("Import failed");
        expect(assertive).not.toHaveTextContent("Saved");
    });

    it("disables Sonner's built-in all-polite live region to avoid duplicate announcements", async () => {
        const {container} = render(<Toaster />);

        act(() => {
            toast.error("Critical error");
        });

        expect(await screen.findByText("Critical error", {selector: "[data-title]"})).toBeInTheDocument();
        expect(container.querySelector("section")).toHaveAttribute("aria-live", "off");
    });

    it("re-announces a same-id loading toast as assertive when it becomes an error", async () => {
        const {container} = render(<Toaster />);
        const polite = container.querySelector<HTMLElement>('[aria-live="polite"]');
        const assertive = container.querySelector<HTMLElement>('[aria-live="assertive"]');
        let id!: string | number;

        act(() => {
            id = toast.loading("Importing transactions");
        });
        await waitFor(() => expect(polite).toHaveTextContent("Importing transactions"));

        act(() => {
            toast.error("Import failed", {id});
        });
        await waitFor(() => expect(assertive).toHaveTextContent("Import failed"));
    });
});
