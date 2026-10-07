// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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
                ok({
                    items: Array.from({ length: 10 }, (_, index) => ({
                        id: index + 1,
                        name: `Investment ${index + 1}`,
                    })),
                    total: 10,
                    limit: 1000,
                    offset: 0,
                }),
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
        const investmentSummary = screen.getByText("Investments", {
            selector: "summary",
        });
        expect(investmentSummary.closest("details")).not.toHaveAttribute(
            "open",
        );
        await user.click(investmentSummary);
        const search = screen.getByRole("searchbox", {
            name: "Search Investments",
        });
        await user.type(search, "Investment 3");
        const checkbox = screen.getByRole("checkbox", { name: "Investment 3" });
        await user.click(checkbox);
        expect(investmentSummary).toHaveTextContent("1 selected");
        await user.click(investmentSummary);
        expect(checkbox).not.toBeVisible();
        await user.click(investmentSummary);
        expect(checkbox).toBeChecked();
        await user.clear(search);
        expect(
            screen.getByRole("checkbox", { name: "Investment 3" }),
        ).toBeChecked();
        await user.type(screen.getByLabelText("Title"), "Valuation review");
        await user.type(
            screen.getByLabelText("Research question"),
            "Is the price justified?",
        );
        await user.click(screen.getByRole("button", { name: /add evidence/i }));
        expect(posted).toBeNull();
        await user.click(
            within(screen.getByLabelText("Origin")).getByRole("radio", {
                name: "AI draft, not verified",
            }),
        );
        await user.type(screen.getByLabelText("Claim"), "Growth may slow");
        await user.type(screen.getByLabelText("Source title"), "Annual report");
        await user.type(screen.getByLabelText("Source reference"), "p. 12");
        await user.click(screen.getByRole("button", { name: /save dossier/i }));
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Dossier saved",
        );
        expect(posted).toMatchObject({
            evidence: [{ origin: "ai-draft" }],
            links: { investmentIds: [3] },
        });
        // Every keystroke re-renders the whole editor (four cards of controls),
        // which is slow under parallel test workers.
    }, 15000);
    it("preserves edited dossiers on reselection and cancelled switches, and discards only after confirmation", async () => {
        const content = {
            title: "First dossier",
            workspace: "research",
            question: "First question",
            userThesis: "",
            assumptions: [],
            openQuestions: [],
            conclusion: "",
            reviewDate: null,
            evidence: [],
            links: { categoryIds: [], investmentIds: [], savedAnalysisIds: [] },
        };
        const dossiers = [
            { ...content, id: "first", version: 1 },
            { ...content, id: "second", title: "Second dossier", version: 1 },
        ];
        let writes = 0;
        server.use(
            http.get(`${api}/research-dossiers`, () =>
                ok({ items: dossiers, total: 2, limit: 500, offset: 0 }),
            ),
            http.get(`${api}/research-dossiers/:id/versions`, () =>
                ok({ items: [] }),
            ),
            http.get(`${api}/research-dossiers/:id`, ({ params }) =>
                ok(dossiers.find((item) => item.id === params.id)),
            ),
            http.get(`${api}/categories/tree`, () =>
                ok({ items: [], total: 0 }),
            ),
            http.get(`${api}/investments`, () => ok({ items: [], total: 0 })),
            http.get(`${api}/analysis/saved`, () => ok({ items: [] })),
            http.get(`${api}/ai-research/documents`, () => ok({ items: [] })),
            http.post(`${api}/research-dossiers`, () => {
                writes += 1;
                return ok({});
            }),
            http.put(`${api}/research-dossiers/:id`, () => {
                writes += 1;
                return ok({});
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<ResearchDossiersPage />);
        await user.click(
            await screen.findByRole("button", { name: /First dossier/ }),
        );
        await screen.findByDisplayValue("First dossier");
        await user.type(screen.getByLabelText("Title"), " edited");
        await user.click(screen.getByRole("button", { name: /First dossier/ }));
        expect(screen.getByLabelText("Title")).toHaveValue(
            "First dossier edited",
        );
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: /Second dossier/ }),
        );
        let dialog = await screen.findByRole("alertdialog");
        await user.click(
            within(dialog).getByRole("button", { name: "Cancel" }),
        );
        expect(screen.getByLabelText("Title")).toHaveValue(
            "First dossier edited",
        );

        await user.click(screen.getByRole("button", { name: /new dossier/i }));
        dialog = await screen.findByRole("alertdialog");
        await user.click(
            within(dialog).getByRole("button", { name: "Cancel" }),
        );
        expect(screen.getByLabelText("Title")).toHaveValue(
            "First dossier edited",
        );

        await user.click(
            screen.getByRole("button", { name: /Second dossier/ }),
        );
        dialog = await screen.findByRole("alertdialog");
        await user.click(
            within(dialog).getByRole("button", { name: "Discard changes" }),
        );
        await waitFor(() =>
            expect(screen.getByLabelText("Title")).toHaveValue(
                "Second dossier",
            ),
        );
        await user.click(screen.getByRole("button", { name: /new dossier/i }));
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Title")).toHaveValue("");
        await user.type(screen.getByLabelText("Title"), "New draft");
        await user.click(screen.getByRole("button", { name: /new dossier/i }));
        dialog = await screen.findByRole("alertdialog");
        await user.click(
            within(dialog).getByRole("button", { name: "Discard changes" }),
        );
        expect(screen.getByLabelText("Title")).toHaveValue("");
        expect(writes).toBe(0);
    });
});
