// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, noContent, ok, ok201 } from "@/test/msw/handlers";
import CategoriesPage from "@/pages/CategoriesPage";

const API_BASE = "http://localhost:3002";
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
        await user.click(screen.getByRole("button", { name: /^expand all$/i }));
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
        await user.selectOptions(
            screen.getByLabelText(/parent category/i),
            "3",
        );
        await user.click(screen.getByRole("button", { name: /^create$/i }));
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
        await user.click(
            await screen.findByRole("button", { name: /^expand all$/i }),
        );
        await user.click(
            screen.getByRole("button", {
                name: "Edit FOOD / GROCERIES / ORGANIC",
            }),
        );
        const select = screen.getByLabelText(/parent category/i);
        expect(select.querySelector('option[value="4"]')).toBeNull();
        await user.selectOptions(select, "1");
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        await waitFor(() => expect(body).toMatchObject({ parentId: 1 }));
    });

    it("does not offer deletion of a node with children", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok({ items: nodes, total: nodes.length }),
            ),
        );
        renderWithApp(<CategoriesPage />);
        expect(
            await screen.findByRole("button", { name: "Delete category FOOD" }),
        ).toBeDisabled();
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
        await user.click(
            await screen.findByRole("button", { name: /^expand all$/i }),
        );
        await user.click(
            screen.getByRole("button", {
                name: "Merge category FOOD / GROCERIES",
            }),
        );
        const target = screen.getByLabelText(/merge into/i);
        expect(target.querySelector('option[value="3"]')).toBeNull();
        expect(target.querySelector('option[value="4"]')).toBeNull();
        await user.selectOptions(target, "1");
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
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: /^expand all$/i }));
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
            await screen.findByText(/error loading categories/i),
        ).toBeInTheDocument();
        spy.mockRestore();
    });

    it("deletes a leaf only after confirmation", async () => {
        const user = userEvent.setup();
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
        await user.click(
            await screen.findByRole("button", { name: /^expand all$/i }),
        );
        await user.click(
            screen.getByRole("button", {
                name: "Delete category FOOD / GROCERIES / ORGANIC / FRUIT",
            }),
        );
        expect(deleted).toBe(false);
        await user.click(screen.getByRole("button", { name: /^delete$/i }));
        await waitFor(() => expect(deleted).toBe(true));
    });
});
