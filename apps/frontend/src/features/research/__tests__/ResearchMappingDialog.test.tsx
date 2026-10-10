// @vitest-environment jsdom

import { http, HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResearchMappingDialog } from "../ResearchMappingDialog";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";

const API_BASE = "http://localhost:3002";

function research(data: unknown) {
    return HttpResponse.json({
        ok: true,
        data,
        meta: { provider: null, source: "live" },
    });
}

describe("ResearchMappingDialog", () => {
    it("shows a retryable resolve error instead of an empty result", async () => {
        const user = userEvent.setup();
        let resolveCalls = 0;
        server.use(
            http.get(`${API_BASE}/api/research/mappings`, () => research({ items: [], total: 0 })),
            http.post(`${API_BASE}/api/research/mappings/resolve`, () => {
                resolveCalls += 1;
                if (resolveCalls === 1) {
                    return HttpResponse.json(
                        { ok: false, error: { message: "provider unavailable" } },
                        { status: 503 },
                    );
                }
                return research({
                    instrument_key: "US0378331005",
                    key_type: "isin",
                    proposals: [],
                    existing: [],
                });
            }),
        );

        renderWithApp(
            <ResearchMappingDialog
                open
                onOpenChange={vi.fn()}
                instrumentKey="US0378331005"
                query="Apple"
            />,
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Could not resolve provider symbols. Try again.",
        );
        expect(screen.queryByText(/no keyed provider returned a match/i)).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Re-resolve" }));

        expect(await screen.findByText(/no keyed provider returned a match/i)).toBeInTheDocument();
        expect(resolveCalls).toBe(2);
    });

    it("does not print a missing provider symbol in the remove confirmation", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/research/mappings`, () =>
                research({
                    items: [
                        {
                            id: 5,
                            instrument_key: "US0378331005",
                            key_type: "isin",
                            provider: "finnhub",
                            provider_symbol: null,
                            resolved_name: null,
                            exchange: null,
                            currency: null,
                            status: "failed",
                            verified_at: null,
                            created_at: "2025-01-01T00:00:00.000Z",
                            updated_at: "2025-01-01T00:00:00.000Z",
                        },
                    ],
                    total: 1,
                }),
            ),
            http.post(`${API_BASE}/api/research/mappings/resolve`, () =>
                research({
                    instrument_key: "US0378331005",
                    key_type: "isin",
                    proposals: [],
                    existing: [],
                }),
            ),
        );

        renderWithApp(
            <ResearchMappingDialog
                open
                onOpenChange={vi.fn()}
                instrumentKey="US0378331005"
                query="Apple"
            />,
        );

        await user.click(
            await screen.findByRole("button", {
                name: "Actions for finnhub mapping",
            }),
        );
        await user.click(
            await screen.findByRole("menuitem", { name: /remove mapping/i }),
        );

        const confirmDialog = await screen.findByRole("alertdialog");
        expect(confirmDialog).toHaveTextContent(/Remove the finnhub mapping/);
        expect(confirmDialog).not.toHaveTextContent(/\bnull\b/);
    });
});
