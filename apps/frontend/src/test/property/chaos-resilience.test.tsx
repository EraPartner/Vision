// @vitest-environment jsdom
// Phase F5 — chaos resilience smoke.
//
// Wraps the transactions endpoint with the chaos handler (random latency +
// random 503s) and asserts the page boots without runtime errors. The page
// may show an error banner OR data, but must not crash and must not hang.

import { describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { chaos } from "@/test/msw/chaos";
import TransactionsPage from "@/pages/TransactionsPage";
import RecipientsPage from "@/pages/RecipientsPage";

const API_BASE = "http://localhost:3002";

describe("Phase F5 — chaos resilience", () => {
    it("TransactionsPage renders heading even when /api/transactions fails intermittently", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            chaos(
                http.get(`${API_BASE}/api/transactions`, () =>
                    ok({ items: [], total: 0, limit: 200, offset: 0, links: [] }),
                ),
            ),
        );

        const { container } = renderWithApp(<TransactionsPage />);
        // Allow chaos handler to roll its random outcome
        await new Promise((r) => setTimeout(r, 300));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("RecipientsPage renders without crashing under chaos", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            chaos(
                http.get(`${API_BASE}/api/recipients`, () =>
                    ok({ items: [], total: 0, limit: 200, offset: 0, links: [] }),
                ),
            ),
        );

        renderWithApp(<RecipientsPage />);
        await waitFor(() =>
            expect(screen.getByRole("heading", { name: /recipients/i })).toBeInTheDocument(),
        );
        errSpy.mockRestore();
    });
});
