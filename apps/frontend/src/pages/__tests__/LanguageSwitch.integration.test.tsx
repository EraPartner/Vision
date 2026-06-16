// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import PlannedPaymentsPage from "@/pages/PlannedPaymentsPage";
import TransactionsPage from "@/pages/TransactionsPage";
import ImportPage from "@/pages/ImportPage";
import TaxOverviewPage from "@/pages/TaxOverviewPage";
import CategoriesPage from "@/pages/CategoriesPage";
import RecipientsPage from "@/pages/RecipientsPage";
import StatisticsPage from "@/pages/StatisticsPage";
import OwesPage from "@/pages/OwesPage";
import DashboardPage from "@/pages/DashboardPage";
import AIChatPage from "@/pages/AIChatPage";
import RecipientInsightsPage from "@/pages/RecipientInsightsPage";
import PortfolioOverviewPage from "@/pages/portfolio/PortfolioOverviewPage";
import AdminOverviewPage from "@/pages/admin/AdminOverviewPage";
import DbMaintenancePage from "@/pages/DbMaintenancePage";
import MarketLookupPage from "@/pages/research/MarketLookupPage";
import NotFound from "@/pages/NotFound";

const API_BASE = "http://localhost:3002";

/** Override settings to force Dutch locale for the duration of one test. */
function useDutch() {
    server.use(
        http.get(`${API_BASE}/api/settings`, () =>
            ok({ app_settings: { language: "nl" } }),
        ),
    );
}

describe("Language switch (integration)", () => {
    // ── PlannedPaymentsPage ──────────────────────────────────────────────────
    it("PlannedPaymentsPage renders English heading by default", async () => {
        renderWithApp(<PlannedPaymentsPage />);
        expect(await screen.findByRole("heading", { name: /planned payments/i })).toBeInTheDocument();
    });

    it("PlannedPaymentsPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<PlannedPaymentsPage />);
        expect(await screen.findByRole("heading", { name: /geplande betalingen/i })).toBeInTheDocument();
    });

    // ── TransactionsPage ─────────────────────────────────────────────────────
    it("TransactionsPage renders English heading by default", async () => {
        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions"] },
        );
        expect(await screen.findByRole("heading", { name: /^transactions$/i })).toBeInTheDocument();
    });

    it("TransactionsPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions"] },
        );
        // Dutch: "Transacties"
        expect(await screen.findByRole("heading", { name: /^transacties$/i })).toBeInTheDocument();
    });

    // ── ImportPage ────────────────────────────────────────────────────────────
    it("ImportPage renders English heading by default", async () => {
        renderWithApp(<ImportPage />);
        expect(await screen.findByRole("heading", { name: /import & export/i })).toBeInTheDocument();
    });

    it("ImportPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<ImportPage />);
        // Dutch: "Importeren & exporteren"
        expect(await screen.findByRole("heading", { name: /importeren & exporteren/i })).toBeInTheDocument();
    });

    // ── TaxOverviewPage ───────────────────────────────────────────────────────
    it("TaxOverviewPage renders English heading by default", async () => {
        renderWithApp(<TaxOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /belgian personal tax overview/i }),
        ).toBeInTheDocument();
    });

    it("TaxOverviewPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<TaxOverviewPage />);
        // Dutch: "Belgisch overzicht van persoonlijke belastingen"
        expect(
            await screen.findByRole("heading", { name: /belgisch overzicht/i }),
        ).toBeInTheDocument();
    });

    // ── CategoriesPage ────────────────────────────────────────────────────────
    it("CategoriesPage renders English heading by default", async () => {
        renderWithApp(<CategoriesPage />);
        expect(
            await screen.findByRole("heading", { name: /^categories$/i }),
        ).toBeInTheDocument();
    });

    it("CategoriesPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<CategoriesPage />);
        // Dutch: categories.title = "Categorieën"
        expect(
            await screen.findByRole("heading", { name: /categorieën/i }),
        ).toBeInTheDocument();
    });

    // ── RecipientsPage ────────────────────────────────────────────────────────
    it("RecipientsPage renders English heading by default", async () => {
        renderWithApp(<RecipientsPage />);
        const headings = await screen.findAllByRole("heading", { name: /all recipients/i });
        expect(headings.length).toBeGreaterThan(0);
    });

    it("RecipientsPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<RecipientsPage />);
        // Dutch: recipientsPage.tableTitle = "Alle ontvangers"
        const headings = await screen.findAllByRole("heading", { name: /alle ontvangers/i });
        expect(headings.length).toBeGreaterThan(0);
    });

    // ── StatisticsPage ────────────────────────────────────────────────────────
    it("StatisticsPage renders English heading by default", async () => {
        renderWithApp(<StatisticsPage />);
        expect(
            await screen.findByRole("heading", { name: /^statistics$/i }),
        ).toBeInTheDocument();
    });

    it("StatisticsPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<StatisticsPage />);
        // Dutch: statsPage.title = "Statistieken"
        expect(
            await screen.findByRole("heading", { name: /statistieken/i }),
        ).toBeInTheDocument();
    });

    // ── OwesPage ──────────────────────────────────────────────────────────────
    it("OwesPage renders English heading by default", async () => {
        renderWithApp(<OwesPage />);
        expect(
            await screen.findByRole("heading", { name: /who owes you/i }),
        ).toBeInTheDocument();
    });

    it("OwesPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<OwesPage />);
        // Dutch: owesPage.title = "Openstaande verordeningen"
        expect(
            await screen.findByRole("heading", { name: /openstaande verordeningen/i }),
        ).toBeInTheDocument();
    });

    // ── DashboardPage ─────────────────────────────────────────────────────────
    it("DashboardPage renders English greeting heading by default", async () => {
        renderWithApp(<DashboardPage />);
        expect(
            await screen.findByRole("heading", { name: /good\s+(morning|afternoon|evening)/i }),
        ).toBeInTheDocument();
    });

    it("DashboardPage renders Dutch greeting heading when language is nl", async () => {
        useDutch();
        renderWithApp(<DashboardPage />);
        // Dutch: "Goedemorgen" / "Goedenmiddag" / "Goedenavond"
        expect(
            await screen.findByRole("heading", { name: /goedemorgen|goedenmiddag|goedenavond/i }),
        ).toBeInTheDocument();
    });

    // ── AIChatPage ────────────────────────────────────────────────────────────
    it("AIChatPage renders English heading by default", async () => {
        renderWithApp(<AIChatPage />);
        expect(
            await screen.findByRole("heading", { name: /^ai chat$/i }),
        ).toBeInTheDocument();
    });

    it("AIChatPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<AIChatPage />);
        // Dutch: aiChat.title = "AI-chat"
        expect(
            await screen.findByRole("heading", { name: /^ai-chat$/i }),
        ).toBeInTheDocument();
    });

    // ── RecipientInsightsPage ─────────────────────────────────────────────────
    it("RecipientInsightsPage renders English heading by default", async () => {
        renderWithApp(<RecipientInsightsPage />);
        expect(
            await screen.findByRole("heading", { name: /recipient insights/i }),
        ).toBeInTheDocument();
    });

    it("RecipientInsightsPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<RecipientInsightsPage />);
        // Dutch: insights.title = "Inzichten per ontvanger"
        expect(
            await screen.findByRole("heading", { name: /inzichten per ontvanger/i }),
        ).toBeInTheDocument();
    });

    // ── PortfolioOverviewPage ─────────────────────────────────────────────────
    it("PortfolioOverviewPage renders English heading by default", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /portfolio overview/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioOverviewPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<PortfolioOverviewPage />);
        // Dutch: portfolio.overviewTitle = "Portefeuille Overzicht"
        expect(
            await screen.findByRole("heading", { name: /portefeuille overzicht/i }),
        ).toBeInTheDocument();
    });

    // ── AdminOverviewPage ─────────────────────────────────────────────────────
    it("AdminOverviewPage renders English heading by default", async () => {
        renderWithApp(<AdminOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /admin overview/i }),
        ).toBeInTheDocument();
    });

    it("AdminOverviewPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<AdminOverviewPage />);
        // Dutch: admin.overview.title = "Beheerdersoverzicht"
        expect(
            await screen.findByRole("heading", { name: /beheerdersoverzicht/i }),
        ).toBeInTheDocument();
    });

    // ── DbMaintenancePage ─────────────────────────────────────────────────────
    it("DbMaintenancePage renders English heading by default", async () => {
        renderWithApp(<DbMaintenancePage />);
        expect(
            await screen.findByRole("heading", { name: /db maintenance/i }),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<DbMaintenancePage />);
        // Dutch: dbMaintenance.title = "DB-onderhoud"
        expect(
            await screen.findByRole("heading", { name: /db-onderhoud/i }),
        ).toBeInTheDocument();
    });

    // ── MarketLookupPage ──────────────────────────────────────────────────────
    it("MarketLookupPage renders English heading by default", async () => {
        renderWithApp(<MarketLookupPage />);
        expect(
            await screen.findByRole("heading", { name: /market lookup/i }),
        ).toBeInTheDocument();
    });

    it("MarketLookupPage renders Dutch heading when language is nl", async () => {
        useDutch();
        renderWithApp(<MarketLookupPage />);
        // Dutch: marketLookup.title = "Marktopzoeker"
        expect(
            await screen.findByRole("heading", { name: /marktopzoeker/i }),
        ).toBeInTheDocument();
    });

    // ── NotFound ──────────────────────────────────────────────────────────────
    it("NotFound renders English page-not-found text by default", async () => {
        renderWithApp(<NotFound />);
        expect(
            await screen.findByText(/page not found/i),
        ).toBeInTheDocument();
    });

    it("NotFound renders Dutch page-not-found text when language is nl", async () => {
        useDutch();
        renderWithApp(<NotFound />);
        // Dutch: notFound.heading = "Pagina niet gevonden"
        expect(
            await screen.findByText(/pagina niet gevonden/i),
        ).toBeInTheDocument();
    });
});
