// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router-dom";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import ImportReviewPage from "@/pages/ImportReviewPage";

const API_BASE = "http://localhost:3002";

function renderReviewPage() {
    renderWithApp(
        <Routes>
            <Route path="/import/:batchId/review" element={<ImportReviewPage />} />
        </Routes>,
        { initialEntries: ["/import/1/review"] },
    );
}

describe("ImportReviewPage (integration)", () => {
    it("renders page heading", async () => {
        renderReviewPage();
        expect(
            await screen.findByRole("heading", { name: /review import/i }),
        ).toBeInTheDocument();
    });

    it("renders without crashing with empty preview data", async () => {
        renderReviewPage();
        await screen.findByRole("heading", { name: /review import/i });
    });

    it("shows Back to Import button when preview loads", async () => {
        renderReviewPage();
        expect(
            await screen.findByRole("button", { name: /back to import/i }),
        ).toBeInTheDocument();
    });

    it("shows Approve & Import button with row count when preview loads", async () => {
        renderReviewPage();
        // MSW returns { groups: [] } → totalRows = 0 → "Approve & Import (0 rows)"
        expect(
            await screen.findByRole("button", { name: /approve & import/i }),
        ).toBeInTheDocument();
    });

    it("shows error message and Back to Import button when preview API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                err(500, "preview unavailable"),
            ),
        );

        renderReviewPage();

        // apiRequest retries on 500 — needs extended timeout
        expect(
            await screen.findByText(/preview unavailable/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("button", { name: /back to import/i }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows error message when preview API fails with 403", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                err(403, "Access denied"),
            ),
        );
        renderReviewPage();
        expect(await screen.findByText(/access denied/i)).toBeInTheDocument();
        expect(
            await screen.findByRole("button", { name: /back to import/i }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("shows subtitle with 0-row count when groups are empty", async () => {
        renderReviewPage();
        // MSW returns groups: [] → totalRows = 0 → subtitle: "0 transactions need your review before importing."
        expect(
            await screen.findByText(/0 transactions need your review/i),
        ).toBeInTheDocument();
    });

    it("Approve & Import button shows 0 rows in label", async () => {
        renderReviewPage();
        expect(
            await screen.findByRole("button", { name: /approve & import \(0 rows\)/i }),
        ).toBeInTheDocument();
    });

    it("shows accordion group names when preview has groups", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        {
                            recipient_id: 1,
                            recipient_name: "Amazon",
                            row_count: 2,
                            rows: [
                                {
                                    id: 10,
                                    tx_date: "2025-03-15",
                                    amount: "-29.99",
                                    currency: "EUR",
                                    recipient_raw: "AMAZON EU SARL",
                                    memo: null,
                                    match_source: "exact",
                                    match_similarity: null,
                                },
                            ],
                            matched_pattern_text: null,
                        },
                    ],
                    totals: { exact: 1, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // Group name appears in accordion trigger
        expect(await screen.findByText("Amazon")).toBeInTheDocument();
    });

    it("shows row count badge in accordion trigger", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        {
                            recipient_id: 2,
                            recipient_name: "Netflix",
                            row_count: 3,
                            rows: [],
                            matched_pattern_text: null,
                        },
                    ],
                    totals: { exact: 3, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // importReview.rowCount = "{n} rows" — accordion shows "3 rows" next to group name
        expect(await screen.findByText(/3 rows/i, { selector: "span" })).toBeInTheDocument();
    });

    it("shows correct row count in Approve button label when preview has groups", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        { recipient_id: 1, recipient_name: "Lidl", row_count: 4, rows: [], matched_pattern_text: null },
                        { recipient_id: 2, recipient_name: "Aldi", row_count: 2, rows: [], matched_pattern_text: null },
                    ],
                    totals: { exact: 6, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // totalRows = 4 + 2 = 6
        expect(
            await screen.findByRole("button", { name: /approve & import \(6 rows\)/i }),
        ).toBeInTheDocument();
    });

    it("calls commit API when Approve & Import button is clicked", async () => {
        const user = userEvent.setup({ delay: null });
        let commitCalled = false;

        server.use(
            http.post(`${API_BASE}/api/import/batches/:batchId/commit`, () => {
                commitCalled = true;
                return ok({ batch_id: 1, imported: 0, duplicates: 0, errors: 0 });
            }),
        );

        renderReviewPage();

        const approveBtn = await screen.findByRole("button", { name: /approve & import/i });
        await user.click(approveBtn);

        expect(commitCalled).toBe(true);
    });

    it("shows match source badges in summary area", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [],
                    totals: { exact: 2, fuzzy: 1, pattern: 0, new: 3, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // exact badge + count
        expect(await screen.findByText("exact")).toBeInTheDocument();
        // fuzzy badge + count
        expect(await screen.findByText("fuzzy")).toBeInTheDocument();
        // new badge + count
        expect(await screen.findByText("new")).toBeInTheDocument();
    });

    it("expands accordion group to show row details when trigger is clicked", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        {
                            recipient_id: 1,
                            recipient_name: "Amazon",
                            row_count: 1,
                            rows: [
                                {
                                    id: 10,
                                    tx_date: "2025-03-15",
                                    amount: "-29.99",
                                    currency: "EUR",
                                    recipient_raw: "AMAZON EU SARL",
                                    memo: null,
                                    match_source: "exact",
                                    match_similarity: null,
                                },
                            ],
                            matched_pattern_text: null,
                        },
                    ],
                    totals: { exact: 1, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // Click the accordion trigger to expand the group
        await user.click(await screen.findByText("Amazon"));

        // Row detail columns become visible after expansion
        expect(await screen.findByText("AMAZON EU SARL")).toBeInTheDocument();
        expect(await screen.findByText("2025-03-15")).toBeInTheDocument();
    });

    it("shows matched pattern text inside expanded accordion group", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        {
                            recipient_id: 3,
                            recipient_name: "Spotify",
                            row_count: 1,
                            rows: [
                                {
                                    id: 20,
                                    tx_date: "2025-04-01",
                                    amount: "-9.99",
                                    currency: "EUR",
                                    recipient_raw: "SPOTIFY AB",
                                    memo: null,
                                    match_source: "pattern",
                                    match_similarity: null,
                                },
                            ],
                            matched_pattern_text: "SPOTIFY*",
                        },
                    ],
                    totals: { exact: 0, fuzzy: 0, pattern: 1, new: 0, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // Expand the accordion
        await user.click(await screen.findByText("Spotify"));

        // importReview.pattern label + pattern value appear in AccordionContent
        expect(await screen.findByText(/SPOTIFY\*/)).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when preview endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                err(404, "Batch not found"),
            ),
        );
        renderReviewPage();
        // Page renders heading or fallback even when preview 404s
        await new Promise((r) => setTimeout(r, 200));
        expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
        errSpy.mockRestore();
    });
});
