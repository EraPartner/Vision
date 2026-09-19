// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import ResearchDossiersPage from "@/pages/research/ResearchDossiersPage";

const api = "http://localhost:3002/api";

describe("ResearchDossiersPage", () => {
    it("creates a dossier only on save and keeps explicit evidence origin", async () => {
        let posted: Record<string, unknown> | null = null;
        server.use(
            http.get(`${api}/research-dossiers`, () =>
                ok({ items: [], total: 0, limit: 500, offset: 0 }),
            ),
            http.get(`${api}/categories/tree`, () =>
                ok({ items: [], total: 0 }),
            ),
            http.get(`${api}/investments`, () =>
                ok({ items: [], total: 0, limit: 1000, offset: 0 }),
            ),
            http.get(`${api}/analysis/saved`, () => ok({ items: [] })),
            http.get(`${api}/ai-research/documents`, () => ok({ items: [] })),
            http.post(`${api}/research-dossiers`, async ({ request }) => {
                posted = (await request.json()) as Record<string, unknown>;
                return ok({ id: "d-1", version: 1, ...posted });
            }),
            http.get(`${api}/research-dossiers/d-1`, () =>
                ok({ id: "d-1", version: 1, ...posted }),
            ),
            http.get(`${api}/research-dossiers/d-1/versions`, () =>
                ok({ items: [] }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<ResearchDossiersPage />);
        await user.click(
            await screen.findByRole("button", { name: /new dossier/i }),
        );
        await user.type(screen.getByLabelText("Title"), "Valuation review");
        await user.type(
            screen.getByLabelText("Research question"),
            "Is the price justified?",
        );
        await user.click(screen.getByRole("button", { name: /add evidence/i }));
        expect(posted).toBeNull();
        await user.selectOptions(screen.getByLabelText("Origin"), "ai-draft");
        await user.type(screen.getByLabelText("Claim"), "Growth may slow");
        await user.type(screen.getByLabelText("Source title"), "Annual report");
        await user.type(screen.getByLabelText("Source reference"), "p. 12");
        await user.click(screen.getByRole("button", { name: /save dossier/i }));
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Dossier saved",
        );
        expect(posted).toMatchObject({ evidence: [{ origin: "ai-draft" }] });
    });
});
