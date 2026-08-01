// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ACCOUNT_STUB, RECIPIENT_STUB, err, ok } from "@/test/msw/handlers";
import ImportReviewPage from "@/pages/ImportReviewPage";

const API_BASE = "http://localhost:3002";

function renderReviewPage() {
    return renderWithApp(
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

    // ─── ADR-046: category review ─────────────────────────────────────────

    it("renders category controls when group is expanded (ADR-046)", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        {
                            recipient_id: 9,
                            recipient_name: "Carrefour",
                            recipient_default_category_id: null,
                            recipient_default_category_label: null,
                            override_category_id: null,
                            current_category_id: null,
                            current_category_label: null,
                            row_count: 1,
                            rows: [
                                {
                                    id: 99,
                                    tx_date: "2026-04-15",
                                    amount: "-12.34",
                                    currency: "EUR",
                                    recipient_raw: "CARREFOUR EXPRESS",
                                    memo: null,
                                    match_source: "exact",
                                    match_similarity: null,
                                    override_category_id: null,
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

        const user = userEvent.setup();
        await user.click(await screen.findByText("Carrefour"));

        // Category label rendered next to combobox.
        expect(await screen.findByText(/^Category$/i)).toBeInTheDocument();
        // Persist-default checkbox visible (recipient has no current default).
        expect(
            await screen.findByLabelText(/save as recipient default/i),
        ).toBeInTheDocument();
    });

    // ─── WP-B6: import disclosure (per-account summary + new-account nudge) ─

    const disclosureRow = (id: number, bankAccount: string | null | undefined) => ({
        id,
        tx_date: "2026-07-01",
        amount: "-10.00",
        currency: "EUR",
        recipient_raw: `ROW ${id}`,
        memo: null,
        match_source: "exact",
        match_similarity: null,
        bank_account: bankAccount,
    });

    const previewWithRows = (rows: ReturnType<typeof disclosureRow>[]) =>
        ok({
            batch_id: 1,
            groups: [
                {
                    recipient_id: 1,
                    recipient_name: "Amazon",
                    row_count: rows.length,
                    rows,
                    matched_pattern_text: null,
                },
            ],
            totals: { exact: rows.length, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
        });

    it("shows per-account disclosure counts and flags only unknown labels as new (WP-B6)", async () => {
        server.use(
            // Existing account "KBC" — identity is case/whitespace-insensitive (D1).
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({ items: [{ ...ACCOUNT_STUB, id: 5, name: "KBC" }], total: 1, links: [] }),
            ),
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                previewWithRows([
                    disclosureRow(1, "KBC"),
                    disclosureRow(2, " kbc "), // same account under D1 normalization
                    disclosureRow(3, "Revolut"), // no matching account → new
                ]),
            ),
        );

        renderReviewPage();

        // "KBC" bucket: 2 rows, existing account → no badge on its line.
        const kbcLabel = await screen.findByText("KBC");
        expect(kbcLabel.parentElement).toHaveTextContent(/2 transactions/i);
        expect(kbcLabel.parentElement).not.toHaveTextContent(/new account will be created/i);

        // "Revolut" bucket: 1 row, unknown label → new-account badge.
        const revolutLabel = await screen.findByText("Revolut");
        expect(revolutLabel.parentElement).toHaveTextContent(/1 transactions/i);
        expect(revolutLabel.parentElement).toHaveTextContent(/new account will be created/i);

        // Exactly one badge in total.
        expect(screen.getAllByText(/new account will be created/i)).toHaveLength(1);
    });

    it("buckets rows without an account label under 'unspecified account' (WP-B6)", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                previewWithRows([disclosureRow(1, null), disclosureRow(2, "  ")]),
            ),
        );

        renderReviewPage();

        const unspecified = await screen.findByText(/unspecified account/i);
        expect(unspecified.parentElement).toHaveTextContent(/2 transactions/i);
        // An empty label is not "a new account" — no badge.
        expect(screen.queryByText(/new account will be created/i)).not.toBeInTheDocument();
    });

    it("post-commit nudge links to the accounts hub when a new account was created (WP-B6)", async () => {
        const user = userEvent.setup({ delay: null });
        const toastSpy = vi.spyOn(toast, "success");

        server.use(
            // Default accounts handler returns no accounts → "Fresh Bank" is new.
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                previewWithRows([disclosureRow(1, "Fresh Bank")]),
            ),
            http.post(`${API_BASE}/api/import/batches/:batchId/commit`, () =>
                ok({ batch_id: 1, imported: 1, duplicates: 0, errors: 0 }),
            ),
        );

        renderReviewPage();

        await screen.findByText(/new account will be created/i);
        await user.click(screen.getByRole("button", { name: /approve & import/i }));

        await vi.waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                "This import created 1 new account(s)",
                expect.objectContaining({
                    action: expect.objectContaining({ label: "Review accounts" }),
                }),
            ),
        );

        toastSpy.mockRestore();
    });

    it("post-commit nudge is absent when every account already exists (WP-B6)", async () => {
        const user = userEvent.setup({ delay: null });
        const toastSpy = vi.spyOn(toast, "success");

        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({ items: [{ ...ACCOUNT_STUB, id: 5, name: "KBC" }], total: 1, links: [] }),
            ),
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                previewWithRows([disclosureRow(1, "KBC")]),
            ),
            http.post(`${API_BASE}/api/import/batches/:batchId/commit`, () =>
                ok({ batch_id: 1, imported: 1, duplicates: 0, errors: 0 }),
            ),
        );

        renderReviewPage();

        await screen.findByText("KBC");
        await user.click(screen.getByRole("button", { name: /approve & import/i }));

        // The plain success toast fires...
        await vi.waitFor(() => expect(toastSpy).toHaveBeenCalled());
        // ...but never the new-accounts nudge.
        const nudgeCalls = toastSpy.mock.calls.filter(
            ([msg]) => typeof msg === "string" && /new account/i.test(msg),
        );
        expect(nudgeCalls).toHaveLength(0);

        toastSpy.mockRestore();
    });

    // ─── Per-group recipient combobox ──────────────────────────────────────
    //
    // Every group's trigger row carries a recipient picker. The page renders
    // them deferred: the visible control is the real Radix trigger, painted
    // from ONE page-level `useRecipients` subscription, and the query + command
    // list mount with the popover. These pin both halves — the row must look
    // and read exactly like a live combobox, and the per-group cost must stay
    // off until a popover actually opens.

    const groupWithRecipient = (recipientId: number, name: string, rowId: number) => ({
        recipient_id: recipientId,
        recipient_name: name,
        row_count: 1,
        rows: [
            {
                id: rowId,
                tx_date: "2026-05-01",
                amount: "-5.00",
                currency: "EUR",
                recipient_raw: `RAW ${rowId}`,
                memo: null,
                match_source: "exact",
                match_similarity: null,
            },
        ],
        matched_pattern_text: null,
    });

    /** Three groups whose recipients all sit inside the fetched page. */
    function useThreeGroups() {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        { ...RECIPIENT_STUB, id: 1, name: "Amazon" },
                        { ...RECIPIENT_STUB, id: 2, name: "Netflix" },
                        { ...RECIPIENT_STUB, id: 3, name: "Spotify" },
                    ],
                    total: 3,
                    limit: 100,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        groupWithRecipient(1, "Amazon", 10),
                        groupWithRecipient(2, "Netflix", 11),
                        groupWithRecipient(3, "Spotify", 12),
                    ],
                    totals: { exact: 3, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
        );
    }

    /** The recipient pickers, in group order. */
    async function findPickers() {
        await vi.waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
        return screen.getAllByRole("combobox");
    }

    it("names each group's current recipient in its trigger combobox", async () => {
        useThreeGroups();
        renderReviewPage();

        const pickers = await findPickers();
        // Same text the live combobox paints in its closed state.
        await vi.waitFor(() => expect(pickers[0]).toHaveTextContent("Amazon"));
        expect(pickers[1]).toHaveTextContent("Netflix");
        expect(pickers[2]).toHaveTextContent("Spotify");
    });

    it("holds one recipients subscription for the whole list, not one per group", async () => {
        useThreeGroups();
        const { queryClient } = renderReviewPage();

        const pickers = await findPickers();
        await vi.waitFor(() => expect(pickers[0]).toHaveTextContent("Amazon"));

        const observers = queryClient
            .getQueryCache()
            .findAll({ queryKey: ["recipients"] })
            .reduce((n, query) => n + query.getObserversCount(), 0);
        // 3 groups, 1 observer. Mounting a live combobox per group would make
        // this scale with the group count (a year of CSV: 100-300+).
        expect(observers).toBe(1);
        // ...and it is a single cache entry, i.e. the page-level resolver reads
        // the very same query key a combobox opens against.
        expect(queryClient.getQueryCache().findAll({ queryKey: ["recipients"] })).toHaveLength(1);
    });

    it("keeps the command list unmounted until a group's popover opens", async () => {
        const user = userEvent.setup();
        useThreeGroups();
        renderReviewPage();

        const [trigger] = await findPickers();
        expect(screen.queryByPlaceholderText(/search recipients/i)).not.toBeInTheDocument();

        await user.click(trigger);
        expect(
            await screen.findByPlaceholderText(/search recipients/i),
        ).toBeInTheDocument();
        // The page-level subscription warms the exact cache entry the popover
        // queries, so the list is populated on open — no empty-then-fill flash.
        expect(screen.getByRole("option", { name: /amazon/i })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /spotify/i })).toBeInTheDocument();

        await user.keyboard("{Escape}");
        await vi.waitFor(() =>
            expect(
                screen.queryByPlaceholderText(/search recipients/i),
            ).not.toBeInTheDocument(),
        );
    });

    it("falls back to the placeholder when the recipient is past the fetched page", async () => {
        // Parity guard: the live combobox resolves its closed label against the
        // first unsearched page and shows the placeholder for anything beyond
        // it. The page-level resolver reads that same page, so the rendered row
        // must be identical — including this fallback.
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [{ ...RECIPIENT_STUB, id: 1, name: "Amazon" }],
                    total: 1,
                    limit: 100,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [groupWithRecipient(2, "Netflix", 11)],
                    totals: { exact: 1, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
        );

        renderReviewPage();

        // The group header still names Netflix; only the picker falls back.
        expect(await screen.findByText("Netflix")).toBeInTheDocument();
        const [picker] = await findPickers();
        expect(picker).toHaveTextContent(/select recipient/i);
    });

    it("assigns a picked recipient to every row of its group", async () => {
        const user = userEvent.setup();
        const overrides: Array<{ rowId: string; recipientId: unknown }> = [];

        useThreeGroups();
        server.use(
            http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
                ok({
                    batch_id: 1,
                    groups: [
                        {
                            ...groupWithRecipient(1, "Amazon", 10),
                            row_count: 2,
                            rows: [
                                groupWithRecipient(1, "Amazon", 10).rows[0],
                                groupWithRecipient(1, "Amazon", 20).rows[0],
                            ],
                        },
                    ],
                    totals: { exact: 2, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
                }),
            ),
            http.post(
                `${API_BASE}/api/import/batches/:batchId/rows/:rowId/override`,
                async ({ params, request }) => {
                    const body = (await request.json()) as { recipient_id: number | null };
                    overrides.push({
                        rowId: String(params.rowId),
                        recipientId: body.recipient_id,
                    });
                    return ok({ row_id: Number(params.rowId), user_override_recipient_id: body.recipient_id });
                },
            ),
        );

        renderReviewPage();

        const [picker] = await findPickers();
        await vi.waitFor(() => expect(picker).toHaveTextContent("Amazon"));
        await user.click(picker);
        await user.click(await screen.findByRole("option", { name: /netflix/i }));

        await vi.waitFor(() => expect(overrides).toHaveLength(2));
        expect(overrides.map((o) => o.rowId).sort()).toEqual(["10", "20"]);
        expect(overrides.every((o) => o.recipientId === 2)).toBe(true);
        // Trigger reflects the pick without waiting for the preview refetch.
        await vi.waitFor(() =>
            expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Netflix"),
        );
    });

    it("is reachable by keyboard and opens on Enter", async () => {
        const user = userEvent.setup();
        useThreeGroups();
        renderReviewPage();

        const [trigger] = await findPickers();
        const back = screen.getByRole("button", { name: /back to import/i });
        back.focus();

        // Tab forward until focus lands on the first group's picker — it must
        // be in the natural tab order, not behind a hover-only affordance.
        for (let i = 0; i < 6 && document.activeElement !== trigger; i++) {
            await user.tab();
        }
        expect(trigger).toHaveFocus();

        await user.keyboard("{Enter}");
        expect(
            await screen.findByPlaceholderText(/search recipients/i),
        ).toBeInTheDocument();
    });

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
