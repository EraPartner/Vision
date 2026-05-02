// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err } from "@/test/msw/handlers";
import { AddCategoryDialog } from "@/features/categories/AddCategoryDialog";

const API_BASE = "http://localhost:3002";

afterEach(() => vi.restoreAllMocks());

describe("AddCategoryDialog (create mode)", () => {
    it("renders trigger button", async () => {
        renderWithApp(<AddCategoryDialog />);
        expect(await screen.findByRole("button", { name: /add category/i })).toBeInTheDocument();
    });

    it("opens dialog on trigger click", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows general, detail, and description fields", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        await screen.findByRole("dialog");
        expect(screen.getByLabelText(/^general$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/^detail$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/description \(optional\)/i)).toBeInTheDocument();
    });

    it("closes when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("submits form and closes dialog on success", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^general$/i), "FOOD");
        await user.type(screen.getByLabelText(/^detail$/i), "GROCERIES");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("does not submit when general field is empty", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^detail$/i), "GROCERIES");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        // Dialog stays open — validation blocked the submit
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("shows error toast when server returns 422 validation error", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        server.use(
            http.post(`${API_BASE}/api/categories`, () => err(422, "category already exists")),
        );
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^general$/i), "FOOD");
        await user.type(screen.getByLabelText(/^detail$/i), "GROCERIES");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/failed to create category/i),
                expect.anything(),
            ),
        );
    });
});

describe("AddCategoryDialog (edit mode)", () => {
    it("renders open when open=true", async () => {
        renderWithApp(
            <AddCategoryDialog
                mode="edit"
                initialValues={{ general: "FOOD", detail: "GROCERIES", description: "" }}
                open={true}
                onOpenChange={vi.fn()}
                onSave={vi.fn()}
            />,
        );
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("populates fields from initialValues", async () => {
        renderWithApp(
            <AddCategoryDialog
                mode="edit"
                initialValues={{ general: "FOOD", detail: "GROCERIES", description: "Food items" }}
                open={true}
                onOpenChange={vi.fn()}
                onSave={vi.fn()}
            />,
        );
        await screen.findByRole("dialog");
        expect(screen.getByDisplayValue("FOOD")).toBeInTheDocument();
        expect(screen.getByDisplayValue("GROCERIES")).toBeInTheDocument();
        expect(screen.getByDisplayValue("Food items")).toBeInTheDocument();
    });

    it("calls onSave with trimmed uppercase values", async () => {
        const onSave = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <AddCategoryDialog
                mode="edit"
                initialValues={{ general: "food", detail: "groceries", description: "  trimmed  " }}
                open={true}
                onOpenChange={vi.fn()}
                onSave={onSave}
            />,
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith({
                general: "FOOD",
                detail: "GROCERIES",
                description: "trimmed",
            }),
        );
    });

    it("calls onOpenChange(false) when Cancel is clicked", async () => {
        const onOpenChange = vi.fn();
        const user = userEvent.setup();
        renderWithApp(
            <AddCategoryDialog
                mode="edit"
                initialValues={{ general: "FOOD", detail: "GROCERIES", description: "" }}
                open={true}
                onOpenChange={onOpenChange}
                onSave={vi.fn()}
            />,
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard) — create mode", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddCategoryDialog />);
        await user.click(await screen.findByRole("button", { name: /add category/i }));
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        expect(inputs.length).toBeGreaterThan(0);
    });
});
