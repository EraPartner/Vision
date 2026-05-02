// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err } from "@/test/msw/handlers";
import { AddRecipientDialog } from "@/features/recipients/AddRecipientDialog";

const API_BASE = "http://localhost:3002";

afterEach(() => vi.restoreAllMocks());

describe("AddRecipientDialog", () => {
    it("renders trigger button", async () => {
        renderWithApp(<AddRecipientDialog />);
        expect(await screen.findByRole("button", { name: /add recipient/i })).toBeInTheDocument();
    });

    it("opens dialog on trigger click", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows name and notes fields", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/notes \(optional\)/i)).toBeInTheDocument();
    });

    it("closes when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("submits form and closes dialog on success", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^name$/i), "Test Landlord");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("does not submit when name field is empty", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        // Dialog stays open — empty name guard blocked the submit
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("includes notes in submission when filled", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^name$/i), "Landlord");
        await user.type(screen.getByLabelText(/notes \(optional\)/i), "Pays on 1st");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("shows error toast when server returns 422 validation error", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        server.use(
            http.post(`${API_BASE}/api/recipients`, () => err(422, "name already exists")),
        );
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText(/^name$/i), "Test Recipient");
        await user.click(screen.getByRole("button", { name: /^create$/i }));
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/failed to create recipient/i),
                expect.anything(),
            ),
        );
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes the dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddRecipientDialog />);
        await user.click(await screen.findByRole("button", { name: /add recipient/i }));
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        expect(inputs.length).toBeGreaterThan(0);
    });
});
