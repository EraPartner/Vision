// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import RecipientsPage from "@/pages/RecipientsPage";

const API_BASE = "http://localhost:3002";

describe("RecipientsPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<RecipientsPage />);
        const headings = await screen.findAllByRole("heading", { name: /all recipients/i });
        expect(headings.length).toBeGreaterThan(0);
    });

    it("renders without crashing when recipient list is empty", async () => {
        renderWithApp(<RecipientsPage />);
        await screen.findAllByRole("heading", { name: /all recipients/i });
    });

    it("shows error state when the recipients API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => err(500, "db unavailable")),
        );

        renderWithApp(<RecipientsPage />);

        // PageError renders the default "Couldn't load this page" h3 (no title prop passed here)
        expect(
            await screen.findByRole("heading", { name: /couldn't load this page/i }, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows Add Recipient button", async () => {
        renderWithApp(<RecipientsPage />);
        expect(
            await screen.findByRole("button", { name: /add recipient/i }),
        ).toBeInTheDocument();
    });

    it("shows Merge Recipients button", async () => {
        renderWithApp(<RecipientsPage />);
        expect(
            await screen.findByRole("button", { name: /merge recipients/i }),
        ).toBeInTheDocument();
    });

    it("opens Add Recipient dialog when button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", { name: /add recipient/i });
        await user.click(addBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /add recipient/i }),
        ).toBeInTheDocument();
    });

    it("opens Merge Recipients dialog when button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const mergeBtn = await screen.findByRole("button", { name: /merge recipients/i });
        await user.click(mergeBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /merge recipients/i }),
        ).toBeInTheDocument();
    });

    it("closes Add Recipient dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", { name: /add recipient/i });
        await user.click(addBtn);

        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /cancel/i }));

        // Dialog should close
        await screen.findAllByRole("heading", { name: /all recipients/i });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows search input for recipients", async () => {
        renderWithApp(<RecipientsPage />);
        // VirtualDataTable server-side search: placeholder = table.searchDatabase = "Search database..."
        expect(
            await screen.findByPlaceholderText(/search database/i),
        ).toBeInTheDocument();
    });

    it("shows empty state when no recipients exist", async () => {
        renderWithApp(<RecipientsPage />);
        // Default MSW returns { items: [] } → EmptyState title = recipientsPage.empty = "No recipients found."
        expect(
            await screen.findByRole("heading", { name: /no recipients found/i }),
        ).toBeInTheDocument();
    });

    it("shows Active Only filter button", async () => {
        renderWithApp(<RecipientsPage />);
        // recipientsPage.activeOnly = "Active Only"
        expect(
            await screen.findByRole("button", { name: /active only/i }),
        ).toBeInTheDocument();
    });

    it("closes Add Recipient dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", { name: /add recipient/i });
        await user.click(addBtn);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens Recipient Patterns dialog when Patterns button is clicked on a row", async () => {
        const user = userEvent.setup();

        // TanStack Virtual reads offsetHeight/offsetWidth (via getRect) to size the scroll container.
        // jsdom returns 0 for both. Mock to 700/1200 so the virtualizer computes visible rows.
        const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
        const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 700 });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        {
                            id: 1,
                            name: "Alice",
                            primary_bank_account: "BE12345",
                            is_active: true,
                            alias_count: 0,
                        },
                    ],
                    total: 1,
                }),
            ),
            http.get(`${API_BASE}/api/recipients/1/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );

        renderWithApp(<RecipientsPage />);

        // recipientPatterns.openBtn = "Patterns" — icon button title on each row
        const patternsBtn = await screen.findByRole("button", { name: /^patterns$/i });
        await user.click(patternsBtn);

        // recipientPatterns.title = "Match Patterns"
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /match patterns/i }),
        ).toBeInTheDocument();

        if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDescriptor);
        if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
    });

    it("Recipient Patterns dialog shows empty-patterns message when no patterns exist", async () => {
        const user = userEvent.setup();

        const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
        const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 700 });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        {
                            id: 1,
                            name: "Alice",
                            primary_bank_account: "BE12345",
                            is_active: true,
                            alias_count: 0,
                        },
                    ],
                    total: 1,
                }),
            ),
            http.get(`${API_BASE}/api/recipients/1/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );

        renderWithApp(<RecipientsPage />);

        const patternsBtn = await screen.findByRole("button", { name: /^patterns$/i });
        await user.click(patternsBtn);

        await screen.findByRole("dialog");

        // recipientPatterns.empty = "No patterns yet. Add one to auto-match future imports."
        expect(
            await screen.findByText(/no patterns yet/i),
        ).toBeInTheDocument();

        if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDescriptor);
        if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
    });

    it("clicking Active Only toggles to Showing All mode", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const activeOnlyBtn = await screen.findByRole("button", { name: /active only/i });
        await user.click(activeOnlyBtn);

        // recipientsPage.showingAll = "Showing All"
        expect(
            await screen.findByRole("button", { name: /showing all/i }),
        ).toBeInTheDocument();
    });

    it("submits Merge Recipients form and calls POST /api/recipients/:id/merge", async () => {
        const user = userEvent.setup();
        let mergeCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        { id: 1, name: "Alice", is_active: true, alias_count: 0, primary_recipient_id: null },
                        { id: 2, name: "Bob", is_active: true, alias_count: 0, primary_recipient_id: null },
                    ],
                    total: 2,
                }),
            ),
            http.post(`${API_BASE}/api/recipients/:primaryId/merge`, () => {
                mergeCalled = true;
                return ok({
                    primary: { id: 1, name: "Alice", is_active: true, alias_count: 1 },
                    merged_ids: [2],
                    aliases: [{ id: 2, name: "Bob" }],
                    patternSuggestion: null,
                });
            }),
        );

        renderWithApp(<RecipientsPage />);

        // Open Merge dialog
        await user.click(await screen.findByRole("button", { name: /merge recipients/i }));
        await screen.findByRole("dialog");

        // Step 1: pick primary — Alice appears in CommandList once data loads
        await user.click(await screen.findByText("Alice"));

        // Step 2: pick alias — Bob appears in alias CommandList (primary is filtered out)
        await user.click(await screen.findByText("Bob"));

        // merge.mergeCount = "Merge {n} recipient(s)" → "Merge 1 recipient(s)"
        await user.click(await screen.findByRole("button", { name: /merge 1 recipient/i }));

        expect(mergeCalled).toBe(true);
    });

    it("submits Add Recipient form and calls POST /api/recipients", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        server.use(
            http.post(`${API_BASE}/api/recipients`, () => {
                postCalled = true;
                return ok({ id: 99, name: "Bob", is_active: true, alias_count: 0 });
            }),
        );

        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", { name: /add recipient/i });
        await user.click(addBtn);

        await screen.findByRole("dialog");

        // form.addRecipient.name = "Name", addRec.namePlaceholder = "Recipient name"
        const nameInput = screen.getByPlaceholderText(/recipient name/i);
        await user.type(nameInput, "Bob");

        // common.create = "Create"
        await user.click(screen.getByRole("button", { name: /^create$/i }));

        expect(postCalled).toBe(true);
    });

    it("Recipient Patterns dialog closes via Escape key", async () => {
        const user = userEvent.setup();

        const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
        const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 700 });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        {
                            id: 1,
                            name: "Alice",
                            primary_bank_account: "BE12345",
                            is_active: true,
                            alias_count: 0,
                        },
                    ],
                    total: 1,
                }),
            ),
            http.get(`${API_BASE}/api/recipients/1/patterns`, () =>
                ok({ items: [], total: 0 }),
            ),
        );

        renderWithApp(<RecipientsPage />);

        const patternsBtn = await screen.findByRole("button", { name: /^patterns$/i });
        await user.click(patternsBtn);

        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDescriptor);
        if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("surfaces 404 error from recipients endpoint", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => err(404, "Not found")),
        );
        renderWithApp(<RecipientsPage />);
        expect(
            await screen.findByText(/error loading recipients/i, {}, { timeout: 4000 }),
        ).toBeInTheDocument();
        errSpy.mockRestore();
    });

    it("renders without crashing with large paginated recipient list", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: Array.from({ length: 50 }, (_, i) => ({
                        id: i + 1,
                        name: `Recipient ${i + 1}`,
                        normalized_name: `recipient ${i + 1}`,
                        is_active: true,
                        created_at: "2025-01-01T00:00:00Z",
                        updated_at: null,
                        links: [],
                    })),
                    total: 250,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );
        renderWithApp(<RecipientsPage />);
        // Page heading still renders even with a large list backing the table
        expect(
            await screen.findByRole("heading", { name: /recipients/i }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/error loading recipients/i)).not.toBeInTheDocument();
    });

    it("after a successful create, the recipients list refetches (stale refetch)", async () => {
        let getCalls = 0;
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => {
                getCalls += 1;
                return ok({ items: [], total: 0, limit: 200, offset: 0, links: [] });
            }),
            http.post(`${API_BASE}/api/recipients`, () =>
                ok({ id: 99, name: "Test", normalized_name: "test", is_active: true, created_at: "2025-01-01T00:00:00Z", updated_at: null, links: [] }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);
        await screen.findByRole("heading", { name: /recipients/i });
        const before = getCalls;

        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^name$/i), "Test Recipient");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(getCalls).toBeGreaterThan(before));
    });

    // ─── Pagination contract ──────────────────────────────────────────────

    it("requests recipients with limit query param (paginated contract)", async () => {
        const limitsSeen: Array<string | null> = [];
        server.use(
            http.get(`${API_BASE}/api/recipients`, ({ request }) => {
                const url = new URL(request.url);
                limitsSeen.push(url.searchParams.get("limit"));
                return ok({ items: [], total: 0, limit: 200, offset: 0, links: [] });
            }),
        );
        renderWithApp(<RecipientsPage />);
        await screen.findByRole("heading", { name: /recipients/i });
        await waitFor(() => expect(limitsSeen.length).toBeGreaterThan(0));
        expect(limitsSeen.every((l) => l !== null && Number(l) > 0)).toBe(true);
    });

    // ─── Loading skeleton ─────────────────────────────────────────────────

    it("renders heading immediately while recipients fetch is pending", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, async () => {
                await new Promise((r) => setTimeout(r, 80));
                return ok({ items: [], total: 0, limit: 200, offset: 0, links: [] });
            }),
        );
        renderWithApp(<RecipientsPage />);
        const heading = await screen.findByRole("heading", { name: /recipients/i });
        expect(heading).toBeInTheDocument();
    });
});
