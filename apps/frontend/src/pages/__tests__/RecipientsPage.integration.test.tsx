// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import RecipientsPage from "@/pages/RecipientsPage";

const API_BASE = "http://localhost:3002";

type User = ReturnType<typeof userEvent.setup>;

async function openViewMenu(user: User) {
    await user.click(await screen.findByRole("button", { name: /^view$/i }));
    return screen.findByRole("menu");
}

async function openPageMenu(user: User) {
    await user.click(
        await screen.findByRole("button", { name: "More actions" }),
    );
    return screen.findByRole("menu");
}

async function openRowMenu(user: User, name: string) {
    await user.click(
        await screen.findByRole("button", { name: `Actions for ${name}` }),
    );
    return screen.findByRole("menu");
}

describe("RecipientsPage (integration)", () => {
    it("recovers the recipient list through Retry", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                err(403, "Unavailable"),
            ),
        );
        renderWithApp(<RecipientsPage />);
        const retry = await screen.findByRole("button", { name: "Retry" });
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({ items: [], total: 0, limit: 200, offset: 0, links: [] }),
            ),
        );
        await user.click(retry);
        expect(
            await screen.findByRole("button", { name: /add payee/i }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Retry" }),
        ).not.toBeInTheDocument();
    });

    it("hydrates show-all, uncategorized, and search state from the URL", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />, {
            initialEntries: [
                "/recipients?show_all=true&uncategorized=true&search=coffee",
            ],
        });

        expect(await screen.findByPlaceholderText(/^search…$/i)).toHaveValue(
            "coffee",
        );
        const menu = await openViewMenu(user);
        expect(
            within(menu).getByRole("menuitemcheckbox", {
                name: /show inactive/i,
                checked: true,
            }),
        ).toBeInTheDocument();
        expect(
            within(menu).getByRole("menuitemcheckbox", {
                name: /uncategorized only/i,
                checked: true,
            }),
        ).toBeInTheDocument();
    });

    it("renders page heading", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);
        const headings = await screen.findAllByRole("heading", {
            name: /all payees/i,
        });
        expect(headings).toHaveLength(1);
        expect(
            await screen.findByRole("button", { name: /add payee/i }),
        ).toBeInTheDocument();
        expect(screen.getByPlaceholderText(/^search…$/i)).toBeInTheDocument();
        const menu = await openPageMenu(user);
        expect(
            within(menu).getByRole("menuitem", { name: /merge payees/i }),
        ).toBeInTheDocument();
    });

    it("renders without crashing when recipient list is empty", async () => {
        renderWithApp(<RecipientsPage />);
        await screen.findAllByRole("heading", { name: /all payees/i });
    });

    it("shows error state when the recipients API fails", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                err(500, "db unavailable"),
            ),
        );

        renderWithApp(<RecipientsPage />);

        // PageError renders the default "Couldn't load this page" h3 (no title prop passed here)
        expect(
            await screen.findByRole(
                "heading",
                { name: /couldn't load this page/i },
                { timeout: 5000 },
            ),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows Add Recipient button", async () => {
        renderWithApp(<RecipientsPage />);
        expect(
            await screen.findByRole("button", { name: /add payee/i }),
        ).toBeInTheDocument();
    });

    it("offers Merge payees in the page menu", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);
        const menu = await openPageMenu(user);
        expect(
            within(menu).getByRole("menuitem", { name: /merge payees/i }),
        ).toBeInTheDocument();
    });

    it("opens Add Recipient dialog when button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", {
            name: /add payee/i,
        });
        await user.click(addBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /add payee/i }),
        ).toBeInTheDocument();
    });

    it("opens Merge Recipients dialog when button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const menu = await openPageMenu(user);
        await user.click(
            within(menu).getByRole("menuitem", { name: /merge payees/i }),
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /merge payees/i }),
        ).toBeInTheDocument();
    });

    it("closes Add Recipient dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", {
            name: /add payee/i,
        });
        await user.click(addBtn);

        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /cancel/i }));

        // Dialog should close
        await screen.findAllByRole("heading", { name: /all payees/i });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows search input for recipients", async () => {
        renderWithApp(<RecipientsPage />);
        // VirtualDataTable server-side search: placeholder = table.searchDatabase = "Search database..."
        expect(
            await screen.findByPlaceholderText(/^search…$/i),
        ).toBeInTheDocument();
    });

    it("shows empty state when no recipients exist", async () => {
        renderWithApp(<RecipientsPage />);
        // Default MSW returns { items: [] } → EmptyState title = recipientsPage.empty = "No recipients found"
        expect(
            await screen.findByRole("heading", {
                name: /no payees found/i,
            }),
        ).toBeInTheDocument();
    });

    it("offers the Show inactive filter in the View menu", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);
        const menu = await openViewMenu(user);
        expect(
            within(menu).getByRole("menuitemcheckbox", {
                name: /show inactive/i,
                checked: false,
            }),
        ).toBeInTheDocument();
    });

    it("links recipient rows and exposes truncated names through a touch disclosure", async () => {
        const heightDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetHeight",
        );
        const widthDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth",
        );
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get: () => 700,
        });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            get: () => 1200,
        });

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        {
                            id: 2,
                            name: "A very long recipient name",
                            primary_recipient_id: 1,
                            primary_recipient_name:
                                "A very long primary recipient name",
                            is_active: true,
                            alias_count: 0,
                        },
                    ],
                    total: 1,
                }),
            ),
        );

        renderWithApp(<RecipientsPage />);

        const recipientLink = await screen.findByRole("link", {
            name: "A very long recipient name",
        });
        expect(recipientLink).toHaveClass("truncate");
        expect(recipientLink).toHaveAttribute(
            "href",
            "/transactions?recipient_id=2&filter_label=A%20very%20long%20recipient%20name",
        );
        expect(
            screen.getByRole("button", { name: "A very long recipient name" }),
        ).toBeInTheDocument();
        const target = await screen.findByTitle(
            "A very long primary recipient name",
        );
        expect(target.querySelector("span")).toHaveClass("truncate");

        const name = "A very long recipient name";
        expect(
            recipientLink.closest("[role='row']") ?? document.body,
        ).toHaveTextContent("Active");
        const user = userEvent.setup();
        const menu = await openRowMenu(user, name);
        expect(
            within(menu).getByRole("menuitem", { name: /^match rules$/i }),
        ).toBeInTheDocument();
        expect(
            within(menu).getByRole("menuitem", { name: /^unmerge$/i }),
        ).toBeInTheDocument();
        expect(
            within(menu).getByRole("menuitem", { name: /^mark inactive$/i }),
        ).toBeInTheDocument();
        expect(
            within(menu).getByRole("menuitem", { name: /^delete$/i }),
        ).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
        );
        await user.click(screen.getByRole("button", { name: `Edit: ${name}` }));
        const recipientInput = screen.getByRole("textbox", {
            name: `Payee: ${name}`,
        });
        expect(recipientInput).toHaveFocus();
        const notesInput = screen.getByRole("textbox", {
            name: `Notes: ${name}`,
        });
        expect(
            screen.getByRole("combobox", { name: `Default category: ${name}` }),
        ).toBeInTheDocument();
        await user.click(notesInput);
        await user.type(notesInput, "Draft note");
        expect(notesInput).toHaveFocus();
        expect(
            screen.getByRole("button", { name: `Save: ${name}` }),
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: `Cancel: ${name}` }),
        );
        expect(
            screen.getByRole("button", { name: `Edit: ${name}` }),
        ).toHaveFocus();

        if (heightDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetHeight",
                heightDescriptor,
            );
        if (widthDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetWidth",
                widthDescriptor,
            );
    });

    it("closes Add Recipient dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", {
            name: /add payee/i,
        });
        await user.click(addBtn);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens Recipient Patterns dialog when Patterns button is clicked on a row", async () => {
        const user = userEvent.setup();

        // TanStack Virtual reads offsetHeight/offsetWidth (via getRect) to size the scroll container.
        // jsdom returns 0 for both. Mock to 700/1200 so the virtualizer computes visible rows.
        const heightDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetHeight",
        );
        const widthDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth",
        );
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get: () => 700,
        });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            get: () => 1200,
        });

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

        await user.click(
            await screen.findByRole("button", { name: /^actions for /i }),
        );
        await user.click(
            await screen.findByRole("menuitem", { name: /^match rules$/i }),
        );

        // recipientPatterns.title = "Match Patterns"
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /match rules/i }),
        ).toBeInTheDocument();

        if (heightDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetHeight",
                heightDescriptor,
            );
        if (widthDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetWidth",
                widthDescriptor,
            );
    });

    it("Recipient Patterns dialog shows empty-patterns message when no patterns exist", async () => {
        const user = userEvent.setup();

        const heightDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetHeight",
        );
        const widthDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth",
        );
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get: () => 700,
        });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            get: () => 1200,
        });

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

        await user.click(
            await screen.findByRole("button", { name: /^actions for /i }),
        );
        await user.click(
            await screen.findByRole("menuitem", { name: /^match rules$/i }),
        );

        await screen.findByRole("dialog");

        // recipientPatterns.empty = "No patterns yet. Add one to auto-match future imports."
        expect(await screen.findByText(/no rules yet/i)).toBeInTheDocument();

        if (heightDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetHeight",
                heightDescriptor,
            );
        if (widthDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetWidth",
                widthDescriptor,
            );
    });

    it("toggling Show inactive from the View menu switches to showing all", async () => {
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);

        const menu = await openViewMenu(user);
        await user.click(
            within(menu).getByRole("menuitemcheckbox", {
                name: /show inactive/i,
                checked: false,
            }),
        );

        const reopened = await openViewMenu(user);
        expect(
            within(reopened).getByRole("menuitemcheckbox", {
                name: /show inactive/i,
                checked: true,
            }),
        ).toBeInTheDocument();
    });

    it("submits Merge Recipients form and calls POST /api/recipients/:id/merge", async () => {
        const user = userEvent.setup();
        let mergeCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        {
                            id: 1,
                            name: "Alice",
                            is_active: true,
                            alias_count: 0,
                            primary_recipient_id: null,
                        },
                        {
                            id: 2,
                            name: "Bob",
                            is_active: true,
                            alias_count: 0,
                            primary_recipient_id: null,
                        },
                    ],
                    total: 2,
                }),
            ),
            http.post(`${API_BASE}/api/recipients/:primaryId/merge`, () => {
                mergeCalled = true;
                return ok({
                    primary: {
                        id: 1,
                        name: "Alice",
                        is_active: true,
                        alias_count: 1,
                    },
                    merged_ids: [2],
                    aliases: [{ id: 2, name: "Bob" }],
                    patternSuggestion: null,
                });
            }),
        );

        renderWithApp(<RecipientsPage />);

        const menu = await openPageMenu(user);
        await user.click(
            within(menu).getByRole("menuitem", { name: /merge payees/i }),
        );
        await screen.findByRole("dialog");

        // Step 1: pick primary — Alice appears in CommandList once data loads
        await user.click(await screen.findByText("Alice"));

        // Step 2: pick alias — Bob appears in alias CommandList (primary is filtered out)
        await user.click(await screen.findByText("Bob"));

        // merge.mergeCount = "Merge {n} recipient(s)" → "Merge 1 recipient(s)"
        await user.click(
            await screen.findByRole("button", { name: /merge 1 payee/i }),
        );

        expect(mergeCalled).toBe(true);
    });

    it("submits Add Recipient form and calls POST /api/recipients", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        server.use(
            http.post(`${API_BASE}/api/recipients`, () => {
                postCalled = true;
                return ok({
                    id: 99,
                    name: "Bob",
                    is_active: true,
                    alias_count: 0,
                });
            }),
        );

        renderWithApp(<RecipientsPage />);

        const addBtn = await screen.findByRole("button", {
            name: /add payee/i,
        });
        await user.click(addBtn);

        await screen.findByRole("dialog");

        // form.addRecipient.name = "Name", addRec.namePlaceholder = "Payee name"
        const nameInput = screen.getByPlaceholderText(/payee name/i);
        await user.type(nameInput, "Bob");

        // recipients.createButton = "Add payee"
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", {
                name: /^add payee$/i,
            }),
        );

        expect(postCalled).toBe(true);
    });

    it("names the recipient, explains delete restrictions, and deletes the confirmed recipient", async () => {
        const user = userEvent.setup();
        let deletedId: string | undefined;
        const heightDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetHeight",
        );
        const widthDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth",
        );
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get: () => 700,
        });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            get: () => 1200,
        });

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [
                        {
                            id: 9,
                            name: "Northwind Market",
                            is_active: true,
                            alias_count: 0,
                        },
                    ],
                    total: 1,
                }),
            ),
            http.delete(`${API_BASE}/api/recipients/:id`, ({ params }) => {
                deletedId = params.id as string;
                return new Response(null, { status: 204 });
            }),
        );

        renderWithApp(<RecipientsPage />);
        const menu = await openRowMenu(user, "Northwind Market");
        await user.click(
            within(menu).getByRole("menuitem", { name: /^delete$/i }),
        );

        const dialog = await screen.findByRole("alertdialog");
        expect(dialog).toHaveTextContent('Delete "Northwind Market"?');
        expect(dialog).toHaveTextContent(
            /transactions, planned payments or accounts cannot be deleted/i,
        );
        expect(dialog).toHaveTextContent(/reassign or merge them first/i);
        expect(deletedId).toBeUndefined();

        await user.click(
            within(dialog).getByRole("button", { name: /^delete$/i }),
        );
        await waitFor(() => expect(deletedId).toBe("9"));

        if (heightDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetHeight",
                heightDescriptor,
            );
        if (widthDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetWidth",
                widthDescriptor,
            );
    });

    it("Recipient Patterns dialog closes via Escape key", async () => {
        const user = userEvent.setup();

        const heightDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetHeight",
        );
        const widthDescriptor = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth",
        );
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get: () => 700,
        });
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            configurable: true,
            get: () => 1200,
        });

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

        await user.click(
            await screen.findByRole("button", { name: /^actions for /i }),
        );
        await user.click(
            await screen.findByRole("menuitem", { name: /^match rules$/i }),
        );

        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        if (heightDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetHeight",
                heightDescriptor,
            );
        if (widthDescriptor)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetWidth",
                widthDescriptor,
            );
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("surfaces 404 error from recipients endpoint", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => err(404, "Not found")),
        );
        renderWithApp(<RecipientsPage />);
        expect(
            await screen.findByText(
                /couldn't load payees/i,
                {},
                { timeout: 4000 },
            ),
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
            await screen.findByRole("heading", { name: /payees/i }),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/couldn't load payees/i),
        ).not.toBeInTheDocument();
    });

    it("after a successful create, the recipients list refetches (stale refetch)", async () => {
        let getCalls = 0;
        server.use(
            http.get(`${API_BASE}/api/recipients`, () => {
                getCalls += 1;
                return ok({
                    items: [],
                    total: 0,
                    limit: 200,
                    offset: 0,
                    links: [],
                });
            }),
            http.post(`${API_BASE}/api/recipients`, () =>
                ok({
                    id: 99,
                    name: "Test",
                    normalized_name: "test",
                    is_active: true,
                    created_at: "2025-01-01T00:00:00Z",
                    updated_at: null,
                    links: [],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<RecipientsPage />);
        await screen.findByRole("heading", { name: /payees/i });
        const before = getCalls;

        await user.click(
            await screen.findByRole("button", { name: /add payee/i }),
        );
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^name$/i), "Test Recipient");
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", {
                name: /^add payee$/i,
            }),
        );
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
        await waitFor(() => expect(getCalls).toBeGreaterThan(before));
    });

    // ─── Pagination contract ──────────────────────────────────────────────

    it("requests recipients with limit query param (paginated contract)", async () => {
        const limitsSeen: Array<string | null> = [];
        server.use(
            http.get(`${API_BASE}/api/recipients`, ({ request }) => {
                const url = new URL(request.url);
                limitsSeen.push(url.searchParams.get("limit"));
                return ok({
                    items: [],
                    total: 0,
                    limit: 200,
                    offset: 0,
                    links: [],
                });
            }),
        );
        renderWithApp(<RecipientsPage />);
        await screen.findByRole("heading", { name: /payees/i });
        await waitFor(() => expect(limitsSeen.length).toBeGreaterThan(0));
        expect(limitsSeen.every((l) => l !== null && Number(l) > 0)).toBe(true);
    });

    // ─── Loading skeleton ─────────────────────────────────────────────────

    it("renders heading immediately while recipients fetch is pending", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients`, async () => {
                await new Promise((r) => setTimeout(r, 80));
                return ok({
                    items: [],
                    total: 0,
                    limit: 200,
                    offset: 0,
                    links: [],
                });
            }),
        );
        renderWithApp(<RecipientsPage />);
        const heading = await screen.findByRole("heading", {
            name: /payees/i,
        });
        expect(heading).toBeInTheDocument();
    });
});
