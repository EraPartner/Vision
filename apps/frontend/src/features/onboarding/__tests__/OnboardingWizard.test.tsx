// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { DASHBOARD_ARRIVAL_EVENT } from "@/utils/dashboardArrival";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { toast } from "sonner";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const API_BASE = "http://localhost:3002";

function installMemoryLocalStorage() {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => backing.get(key) ?? null,
            setItem: (key: string, value: string) =>
                void backing.set(key, String(value)),
            removeItem: (key: string) => void backing.delete(key),
            clear: () => backing.clear(),
        },
    });
}

beforeEach(() => {
    installMemoryLocalStorage();
    vi.clearAllMocks();
});

afterEach(() => {
    localStorage.removeItem(LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT);
    vi.restoreAllMocks();
});

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
    it("resumes a validated draft but does not restore an uploaded file", async () => {
        stubAdapters();
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT,
            JSON.stringify({
                version: 1,
                step: "import",
                selectedBank: "kbc",
                selectedCategoryIndexes: [0, 2],
                categoriesCreated: true,
                importResult: null,
                reviewBatch: null,
            }),
        );

        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);

        expect(
            await screen.findByRole("heading", {
                name: /import your transactions/i,
            }),
        ).toBeInTheDocument();
        expect(await screen.findByText(/kbc/i)).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /^import$/i }),
        ).not.toBeInTheDocument();
    });

    it("returns an unfinished import to bank setup when its adapter was removed", async () => {
        stubAdapters();
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT,
            JSON.stringify({
                version: 1,
                step: "import",
                selectedBank: "removed-bank",
                selectedCategoryIndexes: [],
                categoriesCreated: false,
                importResult: null,
                reviewBatch: null,
            }),
        );

        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        expect(
            await screen.findByRole("heading", { name: /choose your bank/i }),
        ).toBeInTheDocument();
    });

    it("preserves an import draft while adapter discovery is failing", async () => {
        server.use(
            http.get(`${API_BASE}/api/info/supported-adapters`, () =>
                Response.json(
                    { ok: false, error: { message: "offline" } },
                    { status: 500 },
                ),
            ),
        );
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.ONBOARDING_DRAFT,
            JSON.stringify({
                version: 1,
                step: "import",
                selectedBank: "kbc",
                selectedCategoryIndexes: [],
                categoriesCreated: false,
                importResult: null,
                reviewBatch: null,
            }),
        );

        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);

        expect(
            await screen.findByRole("heading", {
                name: /import your transactions/i,
            }),
        ).toBeInTheDocument();
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Could not load supported parsers.",
            ),
        );
    });

    it("warns once when the resumable draft cannot be stored", async () => {
        stubAdapters();
        const original = window.localStorage;
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
                ...original,
                getItem: original.getItem.bind(original),
                removeItem: original.removeItem.bind(original),
                setItem: () => {
                    throw new Error("quota");
                },
            },
        });

        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);

        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Setup progress could not be saved on this device.",
            ),
        );
        expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it("renders the welcome step when open", async () => {
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        expect(
            await screen.findByRole("heading", { name: /welcome to vision/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /get started/i }),
        ).toBeInTheDocument();
    });

    it("does not render dialog content when open=false", () => {
        renderWithApp(<OnboardingWizard open={false} onComplete={vi.fn()} />);
        expect(
            screen.queryByRole("heading", { name: /welcome to vision/i }),
        ).not.toBeInTheDocument();
    });

    it("advances to the next step when Get Started is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        expect(
            await screen.findByRole("heading", { name: /what vision can do/i }),
        ).toBeInTheDocument();
    });

    it("goes back to the previous step when Back is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        await screen.findByRole("heading", { name: /what vision can do/i });
        await user.click(screen.getByRole("button", { name: /back/i }));
        expect(
            await screen.findByRole("heading", { name: /welcome to vision/i }),
        ).toBeInTheDocument();
    });

    it("calls onComplete when Skip setup is clicked on welcome step", async () => {
        const onComplete = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={onComplete} />);
        await user.click(
            await screen.findByRole("button", { name: /skip setup/i }),
        );
        expect(onComplete).toHaveBeenCalled();
    });

    it("renders bank adapters from the API on the bank step", async () => {
        stubAdapters();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        // welcome -> overview -> categories -> bank
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        expect(
            await screen.findByRole("heading", { name: /choose your bank/i }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("button", { name: /^kbc$/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /^ing$/i }),
        ).toBeInTheDocument();
    });

    it("selects a bank when its tile is clicked", async () => {
        stubAdapters();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        const kbcBtn = await screen.findByRole("button", { name: /^kbc$/i });
        const ingBtn = screen.getByRole("button", { name: /^ing$/i });
        expect(kbcBtn).toHaveAttribute("aria-pressed", "false");
        expect(ingBtn).toHaveAttribute("aria-pressed", "false");
        await user.click(kbcBtn);
        // Selection is exposed both visually and through toggle-button semantics.
        expect(kbcBtn.className).toMatch(/border-primary/);
        expect(kbcBtn).toHaveAttribute("aria-pressed", "true");
        expect(ingBtn).toHaveAttribute("aria-pressed", "false");
    });

    it("renders suggested categories on the categories step with select-all toggle", async () => {
        stubAdapters();
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={vi.fn()} />);
        // welcome -> overview -> categories
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        expect(
            await screen.findByRole("heading", { name: /set up categories/i }),
        ).toBeInTheDocument();
        // 15 categories preselected -> sentence-case "Deselect all" visible
        const deselectBtn = screen.getByRole("button", {
            name: "Deselect all",
        });
        await user.click(deselectBtn);
        // After deselecting all, sentence-case "Select all" replaces it and Create button is disabled
        expect(
            await screen.findByRole("button", { name: "Select all" }),
        ).toBeInTheDocument();
        const createBtn = screen.getByRole("button", {
            name: /create 0 categories/i,
        });
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
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        await user.click(
            await screen.findByRole("button", { name: /^next$/i }),
        );
        expect(
            await screen.findByRole("heading", { name: /setup complete/i }),
        ).toBeInTheDocument();
        // Click the "Transactions" feature tile
        await user.click(
            screen.getByRole("button", { name: /transactions.*view, filter/i }),
        );
        expect(onComplete).toHaveBeenCalled();
    });

    it("calls onOpenSettings('backup') and onComplete from the backup step CTA", async () => {
        stubAdapters();
        const onComplete = vi.fn();
        const onOpenSettings = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <OnboardingWizard
                open={true}
                onComplete={onComplete}
                onOpenSettings={onOpenSettings}
            />,
        );
        // 6 clicks: welcome -> overview -> categories -> bank -> import -> tour -> backup
        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        for (let i = 0; i < 5; i++) {
            await user.click(
                await screen.findByRole("button", { name: /^next$/i }),
            );
        }
        expect(
            await screen.findByRole("heading", { name: /protect your data/i }),
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: /set backup location now/i }),
        );
        await waitFor(() => {
            expect(onComplete).toHaveBeenCalled();
            expect(onOpenSettings).toHaveBeenCalledWith("backup");
        });
    });

    it("hands final setup completion to the dashboard reveal", async () => {
        stubAdapters();
        const onComplete = vi.fn();
        const arrival = vi.fn();
        window.addEventListener(DASHBOARD_ARRIVAL_EVENT, arrival);
        const user = userEvent.setup();
        renderWithApp(<OnboardingWizard open={true} onComplete={onComplete} />);

        await user.click(
            await screen.findByRole("button", { name: /get started/i }),
        );
        for (let i = 0; i < 5; i++) {
            await user.click(
                await screen.findByRole("button", { name: /^next$/i }),
            );
        }
        await user.click(
            screen.getByRole("button", { name: /go to dashboard/i }),
        );

        expect(arrival).toHaveBeenCalledOnce();
        expect(onComplete).toHaveBeenCalledOnce();
        window.removeEventListener(DASHBOARD_ARRIVAL_EVENT, arrival);
    });
});
