// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";

const API_BASE = "http://localhost:3002";

afterEach(() => vi.restoreAllMocks());

function stubAdapters() {
    server.use(
        http.get(`${API_BASE}/api/info/supported-adapters`, () =>
            ok({
                items: [
                    { key: "kbc", name: "KBC", adapter_class: "KbcAdapter" },
                    { key: "ing", name: "ING", adapter_class: "IngAdapter" },
                ],
                total: 2,
            }),
        ),
    );
}

describe("OnboardingWizard", () => {
    it("renders the welcome step when open", async () => {
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        expect(await screen.findByRole("heading", { name: /welcome to vision/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /get started/i })).toBeInTheDocument();
    });

    it("does not render dialog content when open=false", () => {
        renderWithApp(<OnboardingWizard open={false} onComplete={vi.fn()} />);
        expect(screen.queryByRole("heading", { name: /welcome to vision/i })).not.toBeInTheDocument();
    });

    it("advances to the next step when Get Started is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        expect(await screen.findByRole("heading", { name: /what vision can do/i })).toBeInTheDocument();
    });

    it("goes back to the previous step when Back is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        await screen.findByRole("heading", { name: /what vision can do/i });
        await user.click(screen.getByRole("button", { name: /back/i }));
        expect(await screen.findByRole("heading", { name: /welcome to vision/i })).toBeInTheDocument();
    });

    it("calls onComplete when Skip setup is clicked on welcome step", async () => {
        const onComplete = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={onComplete} />);
        await user.click(await screen.findByRole("button", { name: /skip setup/i }));
        expect(onComplete).toHaveBeenCalled();
    });

    it("renders bank adapters from the API on the bank step", async () => {
        stubAdapters();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        // welcome -> overview -> categories -> bank
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        expect(await screen.findByRole("heading", { name: /choose your bank/i })).toBeInTheDocument();
        expect(await screen.findByRole("button", { name: /^kbc$/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^ing$/i })).toBeInTheDocument();
    });

    it("selects a bank when its tile is clicked", async () => {
        stubAdapters();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        const kbcBtn = await screen.findByRole("button", { name: /^kbc$/i });
        await user.click(kbcBtn);
        // Selected tile gets the primary border class
        expect(kbcBtn.className).toMatch(/border-primary/);
    });

    it("renders suggested categories on the categories step with select-all toggle", async () => {
        stubAdapters();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        // welcome -> overview -> categories
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        expect(await screen.findByRole("heading", { name: /set up categories/i })).toBeInTheDocument();
        // 15 categories preselected -> "Deselect All" visible
        const deselectBtn = screen.getByRole("button", { name: /deselect all/i });
        await user.click(deselectBtn);
        // After deselecting all, "Select All" replaces it and Create button is disabled
        expect(await screen.findByRole("button", { name: /select all/i })).toBeInTheDocument();
        const createBtn = screen.getByRole("button", { name: /create 0 categories/i });
        expect(createBtn).toBeDisabled();
    });

    it("calls onComplete when the close (X) button is clicked", async () => {
        const onComplete = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={onComplete} />);
        await screen.findByRole("heading", { name: /welcome to vision/i });
        // Find the close button: it's the only icon button in the header next to the Vision brand
        const visionBrand = screen.getByText("Vision");
        const header = visionBrand.closest("div")?.parentElement as HTMLElement;
        const buttons = within(header).getAllByRole("button");
        // Header has just one button — the close (X) icon-only button
        await user.click(buttons[buttons.length - 1]);
        expect(onComplete).toHaveBeenCalled();
    });

    it("navigates and completes when a feature tile is clicked on the tour step", async () => {
        stubAdapters();
        const onComplete = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={onComplete} />);
        // welcome -> overview -> categories -> bank -> import -> tour
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        await user.click(await screen.findByRole("button", { name: /^next$/i }));
        expect(await screen.findByRole("heading", { name: /setup complete/i })).toBeInTheDocument();
        // Click the "Transactions" feature tile
        await user.click(screen.getByRole("button", { name: /transactions.*view, filter/i }));
        expect(onComplete).toHaveBeenCalled();
    });

    it("calls onOpenSettings('backup') and onComplete from the backup step CTA", async () => {
        stubAdapters();
        const onComplete = vi.fn();
        const onOpenSettings = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <OnboardingWizard open={true} onComplete={onComplete} onOpenSettings={onOpenSettings} />,
        );
        // 6 clicks: welcome -> overview -> categories -> bank -> import -> tour -> backup
        await user.click(await screen.findByRole("button", { name: /get started/i }));
        for (let i = 0; i < 5; i++) {
            await user.click(await screen.findByRole("button", { name: /^next$/i }));
        }
        expect(await screen.findByRole("heading", { name: /protect your data/i })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /set backup location now/i }));
        await waitFor(() => {
            expect(onComplete).toHaveBeenCalled();
            expect(onOpenSettings).toHaveBeenCalledWith("backup");
        });
    });
});
