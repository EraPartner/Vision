// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook, screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import CryptoPage from "@/pages/portfolio/CryptoPage";
import { usePortfolioSummaries } from "@/hooks/portfolio/usePortfolioSummaries";
import { useFxAwarePnl } from "@/hooks/portfolio/useFxAwarePnl";
import { renderWithApp } from "@/test/renderWithApp";
import { createQueryWrapper } from "@/test/queryWrapper";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import type { PortfolioSummaryItem } from "@/lib/api/info";
import type { Investment, PortfolioTransaction } from "@/types/api";

const API_BASE = "http://localhost:3002";
const investment: Investment = {
    id: 1,
    name: "Synthetic wallet asset",
    symbol: "SYNTH",
    asset_class: "crypto",
    currency: "USD",
    current_price: 1000,
    is_active: true,
    show_in_ticker: true,
    price_provider: "manual",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
};
// These ordinary rows alone look oversold in account 2. The canonical summary
// also includes the source-to-wallet transfer and asset fee before the sale.
const transactions = [
    {
        id: 1,
        investment_id: 1,
        date: "2025-01-01",
        type: "buy",
        account_id: 1,
        units: 0.25,
        amount: 100,
        fees: 0,
        taxes: 0,
        currency: "USD",
    },
    {
        id: 2,
        investment_id: 1,
        date: "2025-02-01",
        type: "sell",
        account_id: 2,
        units: 0.2,
        amount: 150,
        fees: 0,
        taxes: 0,
        currency: "USD",
    },
] as PortfolioTransaction[];
const canonical: PortfolioSummaryItem = {
    id: 1,
    name: investment.name,
    symbol: "SYNTH",
    asset_class: "crypto",
    assetClass: "crypto",
    is_active: true,
    created_at: investment.created_at,
    updated_at: investment.updated_at,
    currency: "EUR",
    originalCurrency: "USD",
    currentPrice: 800,
    current_price: 800,
    interestRate: 0,
    interest_rate: 0,
    totalUnits: 0.04987654,
    totalInvested: 80,
    totalBuyCost: 80,
    totalSellProceeds: 120,
    currentValue: 39.9,
    totalFees: 1,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 2,
    avgCostBasis: 400,
    realizedGain: 4,
    unrealizedGain: 6,
    totalGain: 10,
    gainLoss: 11,
    gainLossPercent: 13.75,
    assetGain: 10,
    fxGain: 1,
    nativeCurrentValue: 49.88,
    usedFallbackRate: false,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    fullyAssigned: true,
    oversold: false,
    byAccount: [],
};
const response = (summaries = [canonical]) => ({
    currency: summaries[0]?.currency ?? "EUR",
    computed_at: "2025-03-01T00:00:00Z",
    summaries,
    byAccount: [],
    totals: {},
});
function serveMetadata() {
    server.use(
        http.get(`${API_BASE}/api/investments`, () =>
            ok({
                items: [investment],
                total: 1,
                limit: 500,
                offset: 0,
                links: [],
            }),
        ),
        http.get(`${API_BASE}/api/investments/transactions`, () =>
            ok({ items: transactions, total: 2, limit: 1000, offset: 0 }),
        ),
    );
}

describe("canonical portfolio holdings", () => {
    it("shows the custody-and-fee quantity without a false oversold badge", async () => {
        serveMetadata();
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                ok(response()),
            ),
        );
        renderWithApp(<CryptoPage />);
        const units = await screen.findByText("0.04987654");
        const row = units.closest("tr")!;
        expect(within(row).getByText(investment.name)).toBeInTheDocument();
        expect(
            within(row).queryByRole("status", { name: /oversold broker/i }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("0.25000000")).not.toBeInTheDocument();
    });

    it("does not show ordinary-only quantities while the canonical summary loads", async () => {
        serveMetadata();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        let requested = false;
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, async () => {
                requested = true;
                await pending;
                return ok(response());
            }),
        );
        renderWithApp(<CryptoPage />);
        await waitFor(() => expect(requested).toBe(true));
        expect(screen.queryByText("0.25000000")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: /no crypto assets/i }),
        ).not.toBeInTheDocument();
        release();
        expect(await screen.findByText("0.04987654")).toBeInTheDocument();
    });

    it("shows the summary failure instead of an ordinary-only holding", async () => {
        serveMetadata();
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                err(500, "Canonical custody unavailable"),
            ),
        );
        renderWithApp(<CryptoPage />);
        expect(
            await screen.findByText("Canonical custody unavailable"),
        ).toBeInTheDocument();
        expect(screen.queryByText("0.25000000")).not.toBeInTheDocument();
    });

    it.each(["EUR", "USD"])(
        "retains native USD metadata and CRUD rows while using %s canonical money",
        (currency) => {
            const summary = {
                ...canonical,
                currency,
                currentPrice: currency === "EUR" ? 800 : 1000,
            };
            const archived = { ...investment, id: 2, is_active: false };
            const { result } = renderHook(
                () => {
                    const portfolio = usePortfolioSummaries({
                        investments: [investment, archived],
                        transactions,
                        canonicalSummaries: [summary],
                        requireCanonical: true,
                    });
                    const computePnl = useFxAwarePnl(currency);
                    return {
                        portfolio,
                        pnl: computePnl(portfolio.summaries[0]),
                    };
                },
                { wrapper: createQueryWrapper() },
            );
            expect(result.current.portfolio.summaries[0]).toMatchObject({
                totalUnits: 0.04987654,
                oversold: false,
                currency,
                originalCurrency: "USD",
                current_price: 1000,
                currentPrice: summary.currentPrice,
                summarySource: "canonical",
                transactions,
            });
            expect(result.current.pnl).toMatchObject({
                realizedTarget: 4,
                unrealizedTarget: 6,
            });
            expect(result.current.portfolio.inactiveSummaries[0]).toMatchObject(
                { id: 2, summarySource: "local", is_active: false },
            );
        },
    );
});
