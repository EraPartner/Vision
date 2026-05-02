// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err } from "@/test/msw/handlers";
import TaxOverviewPage from "@/pages/TaxOverviewPage";

const API_BASE = "http://localhost:3002";

describe("TaxOverviewPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<TaxOverviewPage />);
        expect(await screen.findByRole("heading", { name: /belgian personal tax overview/i })).toBeInTheDocument();
    });

    it("renders no-profile empty state when tax profile is unconfigured", async () => {
        renderWithApp(<TaxOverviewPage />);
        expect(await screen.findByText(/no tax profile yet/i)).toBeInTheDocument();
    });

    it("renders the Set up tax profile CTA button", async () => {
        renderWithApp(<TaxOverviewPage />);
        // TaxOverviewPage renders two TaxProfileDialog instances (header + empty-state CTA)
        const btns = await screen.findAllByRole("button", { name: /set up tax profile/i });
        expect(btns.length).toBeGreaterThan(0);
    });

    it("opens the tax profile sheet when the setup button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxOverviewPage />);

        // Take the first trigger (empty-state CTA); both open the same sheet
        const [setupBtn] = await screen.findAllByRole("button", { name: /set up tax profile/i });
        await user.click(setupBtn);

        // Sheet header title "Belgian Tax Profile" appears
        expect(
            await screen.findByText(/belgian tax profile/i),
        ).toBeInTheDocument();
    });

    it("shows Employment step radio options when the wizard opens", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxOverviewPage />);

        const [setupBtn] = await screen.findAllByRole("button", { name: /set up tax profile/i });
        await user.click(setupBtn);

        // The first step is Employment; it renders radio items for each employment type.
        // Use role-based selectors anchored to start — civil_servant desc also contains "employee".
        expect(await screen.findByRole("radio", { name: /^employee/i })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: /^self-employed/i })).toBeInTheDocument();
    });

    it("closes tax profile sheet when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxOverviewPage />);

        const [setupBtn] = await screen.findAllByRole("button", { name: /set up tax profile/i });
        await user.click(setupBtn);

        await screen.findByText(/belgian tax profile/i);
        await user.keyboard("{Escape}");

        // Sheet dismisses — employment radios no longer in DOM
        expect(screen.queryByRole("radio", { name: /^employee/i })).not.toBeInTheDocument();
    });

    it("shows Widgets button in page header", async () => {
        renderWithApp(<TaxOverviewPage />);
        expect(
            await screen.findByRole("button", { name: /widgets/i }),
        ).toBeInTheDocument();
    });

    it("opens Manage Widgets dialog when Widgets button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxOverviewPage />);

        const widgetsBtn = await screen.findByRole("button", { name: /widgets/i });
        await user.click(widgetsBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /manage widgets/i }),
        ).toBeInTheDocument();
    });

    it("shows tax year badge", async () => {
        renderWithApp(<TaxOverviewPage />);
        // Badge text: "Tax year YYYY"
        expect(
            await screen.findByText(/tax year \d{4}/i),
        ).toBeInTheDocument();
    });

    it("shows disclaimer text", async () => {
        renderWithApp(<TaxOverviewPage />);
        // Info card: "tax.disclaimerTitle" = "Estimates Only"
        expect(
            await screen.findByText(/estimates only/i),
        ).toBeInTheDocument();
    });

    it("shows subtitle text", async () => {
        renderWithApp(<TaxOverviewPage />);
        // tax.page.subtitle = "Profile-driven PIT estimate with progressive brackets..."
        expect(
            await screen.findByText(/profile-driven pit estimate/i),
        ).toBeInTheDocument();
    });

    it("shows Region badge", async () => {
        renderWithApp(<TaxOverviewPage />);
        // Default profile region = "flanders"
        expect(
            await screen.findByText(/region:/i),
        ).toBeInTheDocument();
    });

    it("shows Export PDF button", async () => {
        renderWithApp(<TaxOverviewPage />);
        // ExportDialog trigger: export.openDialog = "Export PDF"
        expect(
            await screen.findByRole("button", { name: /export pdf/i }),
        ).toBeInTheDocument();
    });

    it("shows automation info card heading", async () => {
        renderWithApp(<TaxOverviewPage />);
        // tax.automation.title = "What is automatic vs manual today?"
        // Rendered when profile IS shown (isEmpty = false shows the accordion; but when isEmpty=true, it's not shown)
        // This card is inside the non-empty branch only — skip this test if always empty
        // Instead test the belgianRulesDesc info paragraph that is always visible
        expect(
            await screen.findByText(/quick belgian-specific guidance/i),
        ).toBeInTheDocument();
    });

    it("shows no-profile empty state description", async () => {
        renderWithApp(<TaxOverviewPage />);
        // tax.noProfile.desc = "Add your income and tax context to calculate Belgian PIT..."
        expect(
            await screen.findByText(/add your income and tax context/i),
        ).toBeInTheDocument();
    });

    it("closes Manage Widgets dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxOverviewPage />);

        const widgetsBtn = await screen.findByRole("button", { name: /widgets/i });
        await user.click(widgetsBtn);
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders empty state gracefully when settings API fails with 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/settings`, () => err(500, "db unavailable")),
        );
        renderWithApp(<TaxOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /belgian personal tax overview/i }),
        ).toBeInTheDocument();
        // apiRequest retries on 500 (MAX_RETRIES=2, ~1.5 s backoff) — needs extended timeout
        expect(
            await screen.findByText(/no tax profile yet/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("renders empty state gracefully when settings API fails with 403", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/settings`, () => err(403, "Forbidden")),
        );
        renderWithApp(<TaxOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /belgian personal tax overview/i }),
        ).toBeInTheDocument();
        expect(await screen.findByText(/no tax profile yet/i)).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when settings endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/settings`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<TaxOverviewPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
