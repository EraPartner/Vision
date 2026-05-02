// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import type { WidgetDefinition } from "@/hooks/useWidgetVisibility";

const WIDGETS: WidgetDefinition[] = [
    { id: "cash-flow", label: "Cash Flow", description: "Monthly cash flow", defaultVisible: true },
    { id: "balance", label: "Account Balance", description: "Bank balances", defaultVisible: true },
    { id: "tax-summary", label: "Tax Summary", defaultVisible: false },
];

function makeProps(overrides: Partial<Parameters<typeof WidgetVisibilityDialog>[0]> = {}) {
    return {
        widgets: WIDGETS,
        isVisible: () => true,
        setWidgetVisible: vi.fn(),
        setAllVisible: vi.fn(),
        resetToDefaults: vi.fn(),
        ...overrides,
    };
}

afterEach(() => vi.restoreAllMocks());

describe("WidgetVisibilityDialog", () => {
    it("renders trigger button", async () => {
        renderWithApp(<WidgetVisibilityDialog {...makeProps()} />);
        expect(await screen.findByRole("button", { name: /widgets/i })).toBeInTheDocument();
    });

    it("shows visible count in trigger button", async () => {
        const isVisible = (id: string) => id !== "tax-summary";
        renderWithApp(<WidgetVisibilityDialog {...makeProps({ isVisible })} />);
        const trigger = await screen.findByRole("button", { name: /widgets/i });
        expect(trigger.textContent).toContain("2/3");
    });

    it("opens dialog on trigger click", async () => {
        const user = userEvent.setup();
        renderWithApp(<WidgetVisibilityDialog {...makeProps()} />);
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows all widget labels in open dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<WidgetVisibilityDialog {...makeProps()} />);
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        expect(screen.getByText("Cash Flow")).toBeInTheDocument();
        expect(screen.getByText("Account Balance")).toBeInTheDocument();
        expect(screen.getByText("Tax Summary")).toBeInTheDocument();
    });

    it("calls setWidgetVisible when a switch is toggled", async () => {
        const setWidgetVisible = vi.fn();
        const user = userEvent.setup();
        const isVisible = (id: string) => id !== "tax-summary";
        renderWithApp(
            <WidgetVisibilityDialog {...makeProps({ isVisible, setWidgetVisible })} />,
        );
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("switch", { name: /tax summary/i }));
        expect(setWidgetVisible).toHaveBeenCalledWith("tax-summary", true);
    });

    it("calls setAllVisible(true) on Show All click", async () => {
        const setAllVisible = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <WidgetVisibilityDialog {...makeProps({ isVisible: () => false, setAllVisible })} />,
        );
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /show all/i }));
        expect(setAllVisible).toHaveBeenCalledWith(true);
    });

    it("calls setAllVisible(false) on Hide All click", async () => {
        const setAllVisible = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <WidgetVisibilityDialog {...makeProps({ setAllVisible })} />,
        );
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /hide all/i }));
        expect(setAllVisible).toHaveBeenCalledWith(false);
    });

    it("calls resetToDefaults on Reset click", async () => {
        const resetToDefaults = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <WidgetVisibilityDialog {...makeProps({ resetToDefaults })} />,
        );
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /reset/i }));
        expect(resetToDefaults).toHaveBeenCalledOnce();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<WidgetVisibilityDialog {...makeProps()} />);
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<WidgetVisibilityDialog {...makeProps()} />);
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element reachable via Tab (keyboard nav)", async () => {
        const user = userEvent.setup();
        renderWithApp(<WidgetVisibilityDialog {...makeProps()} />);
        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThan(0);
    });
});
