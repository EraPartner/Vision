// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, noContent, ok, ok201 } from "@/test/msw/handlers";
import CategoriesPage from "@/pages/CategoriesPage";

const API_BASE = "http://localhost:3002";

type User = ReturnType<typeof userEvent.setup>;

async function expandAll(user: User) {
    await user.click(screen.getByRole("button", { name: /^view$/i }));
    await user.click(
        await screen.findByRole("menuitem", { name: /^expand all$/i }),
    );
}

async function openRowMenu(user: User, path: string) {
    await user.click(
        screen.getByRole("button", { name: `Actions for ${path}` }),
    );
}

async function chooseOption(user: User, combobox: HTMLElement, name: string) {
    await user.click(combobox);
    await user.click(await screen.findByRole("option", { name }));
}

const nodes = [
    {
        id: 1,
        name: "FOOD",
        parentId: null,
        pathIds: [1],
        path: ["FOOD"],
        category_name: "FOOD",
        depth: 1,
        is_active: true,
        hierarchyOnly: true,
        legacyCompatible: true,
    },
    {
        id: 2,
        name: "GROCERIES",
        parentId: 1,
        pathIds: [1, 2],
        path: ["FOOD", "GROCERIES"],
        category_name: "FOOD:GROCERIES",
        depth: 2,
        is_active: true,
        hierarchyOnly: false,
        legacyCompatible: true,
    },
    {
        id: 3,
        name: "ORGANIC",
        parentId: 2,
        pathIds: [1, 2, 3],
        path: ["FOOD", "GROCERIES", "ORGANIC"],
        category_name: "FOOD:GROCERIES:ORGANIC",
        depth: 3,
        is_active: true,
        hierarchyOnly: false,
        legacyCompatible: false,
    },
    {
        id: 4,
        name: "FRUIT",
        parentId: 3,
        pathIds: [1, 2, 3, 4],
        path: ["FOOD", "GROCERIES", "ORGANIC", "FRUIT"],
        category_name: "FOOD:GROCERIES:ORGANIC:FRUIT",
        depth: 4,
        is_active: true,
        hierarchyOnly: false,
        legacyCompatible: false,
    },
];

describe("CategoriesPage hierarchy", () => {
    it("marks inactive categories and offers the opposite status in the row menu", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({
                    items: [{ ...nodes[0], is_active: false }, nodes[1]],
                    total: 2,
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<CategoriesPage />);
        const foodLink = await screen.findByRole("link", { name: "FOOD" });
        expect(foodLink.closest("li")).toHaveTextContent("Inactive");
        await openRowMenu(user, "FOOD");
        expect(
            await screen.findByRole("menuitem", { name: /^mark active$/i }),
        ).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await expandAll(user);
        await openRowMenu(user, "FOOD / GROCERIES");
        expect(
            await screen.findByRole("menuitem", { name: /^mark inactive$/i }),
        ).toBeInTheDocument();
    });

    it("toggles a category's status at once and offers undo", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        const patches: unknown[] = [];
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
            http.patch(
                `${API_BASE}/api/categories/tree/:id`,
                async ({ request }) => {
                    patches.push(await request.json());
                    return ok({ ...nodes[0], is_active: false });
                },
            ),
        );
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("link", { name: "FOOD" });
        await openRowMenu(user, "FOOD");
        await user.click(
            await screen.findByRole("menuitem", { name: /^mark inactive$/i }),
        );
        await waitFor(() => expect(patches).toEqual([{ is_active: false }]));
        await waitFor(() =>
            expect(success).toHaveBeenCalledWith(
                "FOOD marked inactive",
                expect.objectContaining({
                    action: expect.objectContaining({ label: "Undo" }),
                }),
            ),
        );
        const undo = success.mock.calls.at(-1)?.[1] as unknown as {
            action: { onClick: () => void };
        };
        undo.action.onClick();
        await waitFor(() =>
            expect(patches).toEqual([
                { is_active: false },
                { is_active: true },
            ]),
        );
        success.mockRestore();
    });

    it.each([
        ["Edit", /^edit$/i],
        ["Merge category", /^merge category$/i],
        ["Delete", /^delete$/i],
    ])(
        "returns keyboard focus to the row menu after cancelling %s",
        async (_action, item) => {
            server.use(
                http.get(`${API_BASE}/api/categories/tree`, () =>
                    ok({ items: nodes, total: nodes.length }),
                ),
            );
            const user = userEvent.setup();
            renderWithApp(<CategoriesPage />);
            await screen.findByRole("link", { name: "FOOD" });
            await expandAll(user);
            const opener = screen.getByRole("button", {
                name: "Actions for FOOD / GROCERIES / ORGANIC / FRUIT",
            });
            opener.focus();
            await user.keyboard("{Enter}");
            await user.click(
                await screen.findByRole("menuitem", { name: item }),
            );
            await user.click(
                await screen.findByRole("button", { name: /^cancel$/i }),
            );
            await waitFor(() => expect(opener).toHaveFocus());
        },
    );

    it("shows an empty tree and the create action", async () => {
        renderWithApp(<CategoriesPage />);
        expect(
            await screen.findByText(/no categories yet/i),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /add category/i }),
        ).toBeInTheDocument();
    });

    it("expands arbitrary depth and links an ancestor by stable ID", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
        );
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("link", { name: "FOOD" });
        await expandAll(user);
        expect(screen.getByRole("link", { name: "FRUIT" })).toHaveAttribute(
            "href",
            "/transactions?category_id=4&filter_label=FOOD%20%2F%20GROCERIES%20%2F%20ORGANIC%20%2F%20FRUIT",
        );
        expect(screen.getByRole("link", { name: "FOOD" })).toHaveAttribute(
            "href",
            "/transactions?category_ids=1%2C2%2C3%2C4&filter_label=FOOD",
        );
    });

    it("creates a child using the parent node ID, not a split display label", async () => {
        const user = userEvent.setup();
        let body: unknown;
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
            http.post(
                `${API_BASE}/api/categories/tree`,
                async ({ request }) => {
                    body = await request.json();
                    return ok201(nodes[3]);
                },
            ),
        );
        renderWithApp(<CategoriesPage />);
        await user.click(
            await screen.findByRole("button", { name: /add category/i }),
        );
        await user.type(screen.getByLabelText(/^name$/i), "fruit");
        await chooseOption(
            user,
            screen.getByLabelText(/parent category/i),
            "FOOD / GROCERIES / ORGANIC",
        );
        await user.click(
            screen.getByRole("button", { name: /^add category$/i }),
        );
        await waitFor(() =>
            expect(body).toMatchObject({ name: "fruit", parentId: 3 }),
        );
    });

    it("edits a node and excludes its descendants from move targets", async () => {
        const user = userEvent.setup();
        let body: unknown;
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
            http.patch(
                `${API_BASE}/api/categories/tree/:id`,
                async ({ request }) => {
                    body = await request.json();
                    return ok(nodes[2]);
                },
            ),
        );
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("link", { name: "FOOD" });
        await expandAll(user);
        await openRowMenu(user, "FOOD / GROCERIES / ORGANIC");
        await user.click(
            await screen.findByRole("menuitem", { name: /^edit$/i }),
        );
        const select = await screen.findByLabelText(/parent category/i);
        await user.click(select);
        await screen.findByRole("option", { name: "FOOD" });
        expect(
            screen.queryByRole("option", {
                name: "FOOD / GROCERIES / ORGANIC / FRUIT",
            }),
        ).toBeNull();
        await user.click(screen.getByRole("option", { name: "FOOD" }));
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        await waitFor(() => expect(body).toMatchObject({ parentId: 1 }));
    });

    it("does not offer deletion of a node with children", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("link", { name: "FOOD" });
        await openRowMenu(user, "FOOD");
        const item = await screen.findByRole("menuitem", { name: /^delete/i });
        expect(item).toHaveAttribute("aria-disabled", "true");
        expect(item).toHaveTextContent(
            /move or delete child categories first/i,
        );
    });

    it("merges a branch into an active target outside its subtree", async () => {
        const user = userEvent.setup();
        let merged: { sourceId?: string; body?: unknown } = {};
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
            http.post(
                `${API_BASE}/api/categories/tree/:id/merge`,
                async ({ params, request }) => {
                    merged = {
                        sourceId: String(params.id),
                        body: await request.json(),
                    };
                    return ok(nodes[0]);
                },
            ),
        );
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("link", { name: "FOOD" });
        await expandAll(user);
        await openRowMenu(user, "FOOD / GROCERIES");
        await user.click(
            await screen.findByRole("menuitem", { name: /^merge category$/i }),
        );
        const target = await screen.findByLabelText(/merge into/i);
        await user.click(target);
        await screen.findByRole("option", { name: "FOOD" });
        expect(
            screen.queryByRole("option", {
                name: "FOOD / GROCERIES / ORGANIC",
            }),
        ).toBeNull();
        expect(
            screen.queryByRole("option", {
                name: "FOOD / GROCERIES / ORGANIC / FRUIT",
            }),
        ).toBeNull();
        await user.click(screen.getByRole("option", { name: "FOOD" }));
        await user.click(screen.getByRole("button", { name: /^merge$/i }));
        await waitFor(() =>
            expect(merged).toEqual({ sourceId: "2", body: { targetId: 1 } }),
        );
    });

    it("keeps an inactive ancestor as context for an active descendant", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({
                    items: [{ ...nodes[0], is_active: false }, nodes[1]],
                    total: 2,
                }),
            ),
        );
        renderWithApp(<CategoriesPage />);
        expect(
            await screen.findByRole("link", { name: "FOOD" }),
        ).toBeInTheDocument();
        await expandAll(userEvent.setup());
        expect(
            screen.getByRole("link", { name: "GROCERIES" }),
        ).toBeInTheDocument();
    });

    it("reports a hierarchy API error", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                err(500, "db unavailable"),
            ),
        );
        renderWithApp(<CategoriesPage />);
        expect(
            await screen.findByText(/couldn't load categories/i),
        ).toBeInTheDocument();
        spy.mockRestore();
    });

    it("deletes a leaf only after confirmation and confirms the deletion", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        let deleted = false;
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
            http.delete(`${API_BASE}/api/categories/tree/:id`, () => {
                deleted = true;
                return noContent();
            }),
        );
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("link", { name: "FOOD" });
        await expandAll(user);
        await openRowMenu(user, "FOOD / GROCERIES / ORGANIC / FRUIT");
        await user.click(
            await screen.findByRole("menuitem", { name: /^delete$/i }),
        );
        expect(deleted).toBe(false);
        expect(success).not.toHaveBeenCalled();
        await user.click(
            await screen.findByRole("button", { name: /^delete$/i }),
        );
        await waitFor(() => expect(deleted).toBe(true));
        await waitFor(() => {
            expect(success).toHaveBeenCalledWith("Category deleted");
        });
        success.mockRestore();
    });
});
