// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import CategoriesPage from "@/pages/CategoriesPage";

const API_BASE = "http://localhost:3002";

describe("CategoriesPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("heading", { name: /^categories$/i });
    });

    it("renders without crashing when category list is empty", async () => {
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("heading", { name: /^categories$/i });
    });

    it("shows error state when the categories API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/categories`, () => err(500, "db unavailable")),
        );

        renderWithApp(<CategoriesPage />);

        expect(
            await screen.findByText(/error loading categories/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("opens Add Category dialog, fills form, and calls POST /api/categories on submit", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        server.use(
            http.post(`${API_BASE}/api/categories`, () => {
                postCalled = true;
                return ok({ id: 99, general: "FOOD", detail: "GROCERIES", is_active: true });
            }),
        );

        renderWithApp(<CategoriesPage />);

        // Page must be out of loading state first
        await screen.findByRole("heading", { name: /^categories$/i });

        // Open the Add Category dialog via the trigger button
        const triggerBtn = await screen.findByRole("button", { name: /add category/i });
        await user.click(triggerBtn);

        // Dialog should be visible
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        // Fill in the General field
        const generalInput = screen.getByLabelText(/general/i);
        await user.clear(generalInput);
        await user.type(generalInput, "FOOD");

        // Fill in the Detail field
        const detailInput = screen.getByLabelText(/detail/i);
        await user.clear(detailInput);
        await user.type(detailInput, "GROCERIES");

        // Submit
        await user.click(screen.getByRole("button", { name: /create/i }));

        expect(postCalled).toBe(true);
    });

    it("closes Add Category dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<CategoriesPage />);

        await screen.findByRole("heading", { name: /^categories$/i });

        const triggerBtn = await screen.findByRole("button", { name: /add category/i });
        await user.click(triggerBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /cancel/i }));

        // Dialog should close
        await screen.findByRole("heading", { name: /^categories$/i });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes Add Category dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<CategoriesPage />);

        await screen.findByRole("heading", { name: /^categories$/i });

        const triggerBtn = await screen.findByRole("button", { name: /add category/i });
        await user.click(triggerBtn);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows Category Tree section heading", async () => {
        renderWithApp(<CategoriesPage />);
        // categoriesPage.treeTitle = "Category Tree"
        expect(
            await screen.findByText(/category tree/i),
        ).toBeInTheDocument();
    });

    it("shows empty categories message when category list is empty", async () => {
        renderWithApp(<CategoriesPage />);
        // Default MSW returns { items: [] }.
        expect(
            await screen.findByText(/no categories yet.*import a categories csv/i),
        ).toBeInTheDocument();
    });

    it("shows Expand All button when page loads", async () => {
        renderWithApp(<CategoriesPage />);
        // categoriesPage.expandAll = "Expand All" (rendered when allExpanded = false)
        expect(
            await screen.findByRole("button", { name: /expand all/i }),
        ).toBeInTheDocument();
    });

    it("shows Active Only filter button", async () => {
        renderWithApp(<CategoriesPage />);
        // categoriesPage.activeOnly = "Active Only"
        expect(
            await screen.findByRole("button", { name: /active only/i }),
        ).toBeInTheDocument();
    });

    it("expands category group when group header is clicked", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                ok({
                    items: [{ id: 1, general: "FOOD", detail: "A VERY LONG GROCERY CATEGORY", is_active: true }],
                    total: 1,
                }),
            ),
        );

        renderWithApp(<CategoriesPage />);

        // Group header button should appear with the general name
        const groupBtn = await screen.findByRole("button", { name: /food/i });
        await user.click(groupBtn);

        // Detail row badge becomes visible after expand
        const detail = await screen.findByText("A VERY LONG GROCERY CATEGORY");
        expect(detail).toHaveClass("truncate");
        expect(detail.closest("[title]")).toHaveAttribute("title", "A VERY LONG GROCERY CATEGORY");
    });

    it("shows category count subtitle when page loads", async () => {
        renderWithApp(<CategoriesPage />);
        // categoriesPage.subtitle = "{n} categories in {g} groups"
        // With default MSW data (empty items): "0 categories in 0 groups"
        expect(
            await screen.findByText(/0 categories in 0 groups/i),
        ).toBeInTheDocument();
    });

    it("opens Edit Category dialog when edit button is clicked on a category", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                ok({
                    items: [{ id: 1, general: "FOOD", detail: "GROCERIES", is_active: true }],
                    total: 1,
                }),
            ),
        );

        renderWithApp(<CategoriesPage />);

        // Expand the group first
        const groupBtn = await screen.findByRole("button", { name: /food/i });
        await user.click(groupBtn);

        // Edit icon button has title = t('common.edit') = "Edit"
        const editBtn = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editBtn);

        // form.addCategory.editTitle = "Edit Category"
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /^edit category$/i }),
        ).toBeInTheDocument();
    });

    it("closes Edit Category dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                ok({
                    items: [{ id: 1, general: "FOOD", detail: "GROCERIES", is_active: true }],
                    total: 1,
                }),
            ),
        );

        renderWithApp(<CategoriesPage />);

        const groupBtn = await screen.findByRole("button", { name: /food/i });
        await user.click(groupBtn);

        const editBtn = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editBtn);

        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /cancel/i }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes Edit Category dialog via Escape key", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                ok({
                    items: [{ id: 1, general: "FOOD", detail: "GROCERIES", is_active: true }],
                    total: 1,
                }),
            ),
        );

        renderWithApp(<CategoriesPage />);

        const groupBtn = await screen.findByRole("button", { name: /food/i });
        await user.click(groupBtn);

        const editBtn = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editBtn);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("clicking Active Only toggles to Showing All mode", async () => {
        const user = userEvent.setup();
        renderWithApp(<CategoriesPage />);

        const activeOnlyBtn = await screen.findByRole("button", { name: /active only/i });
        await user.click(activeOnlyBtn);

        // categoriesPage.showingAll = "Showing All"
        expect(
            await screen.findByRole("button", { name: /showing all/i }),
        ).toBeInTheDocument();
    });

    it("clicking Expand All with categories present toggles to Collapse All", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                ok({
                    items: [{ id: 1, general: "FOOD", detail: "GROCERIES", is_active: true }],
                    total: 1,
                }),
            ),
        );

        renderWithApp(<CategoriesPage />);

        // Click Expand All — only enabled when groups exist
        const expandAllBtn = await screen.findByRole("button", { name: /expand all/i });
        await user.click(expandAllBtn);

        // categoriesPage.collapseAll = "Collapse All" — button label flips
        expect(
            await screen.findByRole("button", { name: /collapse all/i }),
        ).toBeInTheDocument();
    });

    it("submitting Edit Category form calls PATCH /api/categories/:id", async () => {
        const user = userEvent.setup();
        let patchCalled = false;
        let patchedId: string | undefined;

        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                ok({
                    items: [{ id: 1, general: "FOOD", detail: "GROCERIES", is_active: true }],
                    total: 1,
                }),
            ),
            http.patch(`${API_BASE}/api/categories/:id`, ({ params }) => {
                patchCalled = true;
                patchedId = params.id as string;
                return ok({ id: 1, general: "FOOD", detail: "ORGANIC", is_active: true });
            }),
        );

        renderWithApp(<CategoriesPage />);

        // Expand the FOOD group to reveal the edit button
        const groupBtn = await screen.findByRole("button", { name: /food/i });
        await user.click(groupBtn);

        // Open Edit Category dialog
        const editBtn = await screen.findByRole("button", { name: /^edit$/i });
        await user.click(editBtn);

        await screen.findByRole("dialog");

        // Change the Detail field
        const detailInput = screen.getByLabelText(/detail/i);
        await user.clear(detailInput);
        await user.type(detailInput, "ORGANIC");

        // Submit — form.addCategory.save = "Save"
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        expect(patchCalled).toBe(true);
        expect(patchedId).toBe("1");
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when categories endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/categories`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<CategoriesPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("after a successful create, the categories list refetches (stale refetch)", async () => {
        let getCalls = 0;
        server.use(
            http.get(`${API_BASE}/api/categories`, () => {
                getCalls += 1;
                return ok({ items: [], total: 0, limit: 200, offset: 0, links: [] });
            }),
            http.post(`${API_BASE}/api/categories`, () =>
                ok({ id: 99, general: "FOOD", detail: "GROCERIES", is_active: true }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<CategoriesPage />);
        await screen.findByRole("heading", { name: /^categories$/i });
        const initial = getCalls;

        const triggerBtn = await screen.findByRole("button", { name: /add category/i });
        await user.click(triggerBtn);
        await screen.findByRole("dialog");
        const generalInput = screen.getByLabelText(/general/i);
        await user.type(generalInput, "FOOD");
        const detailInput = screen.getByLabelText(/detail/i);
        await user.type(detailInput, "GROCERIES");
        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(getCalls).toBeGreaterThan(initial));
    });
});
