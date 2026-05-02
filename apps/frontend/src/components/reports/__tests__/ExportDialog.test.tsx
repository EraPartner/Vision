// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ExportDialog } from "@/components/reports/ExportDialog";

// jsdom does not implement these blob URL APIs
beforeEach(() => {
    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:fake");
    global.URL.revokeObjectURL = vi.fn();
});

// The ExportDialog uses fetch() with a relative URL (/api/reports/financial).
// In msw/node (used in Vitest), relative URLs are intercepted by path only —
// without a host prefix in the handler pattern.
const REPORT_URL = "/api/reports/financial";

/** Stub a successful PDF response on the relative-URL fetch path. */
function stubFinancialSuccess() {
    server.use(
        http.post(REPORT_URL, () =>
            new HttpResponse(new Blob(["PDF"], { type: "application/pdf" }), {
                status: 200,
            }),
        ),
    );
}

/** Stub a failing PDF response. */
function stubFinancialError() {
    server.use(
        http.post(REPORT_URL, () =>
            new HttpResponse(null, { status: 500, statusText: "Internal Server Error" }),
        ),
    );
}

async function openDialog() {
    const user = userEvent.setup();
    renderWithApp(<ExportDialog />);
    const trigger = await screen.findByRole("button", { name: /export pdf/i });
    await user.click(trigger);
    await screen.findByRole("dialog");
    return user;
}

describe("ExportDialog", () => {
    it("renders trigger button", async () => {
        renderWithApp(<ExportDialog />);
        expect(
            await screen.findByRole("button", { name: /export pdf/i }),
        ).toBeInTheDocument();
    });

    it("clicking trigger opens dialog", async () => {
        await openDialog();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("shows financial report sections by default", async () => {
        await openDialog();
        // The financial sections heading and at least one section label should appear
        expect(await screen.findByText(/executive summary/i)).toBeInTheDocument();
        expect(await screen.findByText(/cashflow trend/i)).toBeInTheDocument();
    });

    it("switching to portfolio report type shows portfolio sections", async () => {
        const user = await openDialog();
        const portfolioRadio = await screen.findByRole("radio", { name: /portfolio/i });
        await user.click(portfolioRadio);
        expect(await screen.findByText(/portfolio summary/i)).toBeInTheDocument();
        expect(await screen.findByText(/portfolio allocation/i)).toBeInTheDocument();
    });

    it("switching to tax report type shows tax sections", async () => {
        const user = await openDialog();
        const taxRadio = await screen.findByRole("radio", { name: /^tax$/i });
        await user.click(taxRadio);
        expect(await screen.findByText(/tax summary/i)).toBeInTheDocument();
        expect(await screen.findByText(/tax type breakdown/i)).toBeInTheDocument();
    });

    it("Download button disabled when all sections unchecked", async () => {
        const user = await openDialog();
        // The "All" checkbox toggles all sections — click it to uncheck all
        const allCheckbox = await screen.findByRole("checkbox", { name: /^all$/i });
        await user.click(allCheckbox); // uncheck all
        const downloadBtn = await screen.findByRole("button", { name: /download pdf/i });
        expect(downloadBtn).toBeDisabled();
    });

    it("successful download closes dialog", async () => {
        stubFinancialSuccess();
        const user = await openDialog();
        const downloadBtn = await screen.findByRole("button", { name: /download pdf/i });
        await user.click(downloadBtn);
        await waitFor(() => {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    it("download error keeps dialog open", async () => {
        stubFinancialError();
        const user = await openDialog();
        const downloadBtn = await screen.findByRole("button", { name: /download pdf/i });
        await user.click(downloadBtn);
        // Wait for the async error path to settle, then dialog should still be present
        await waitFor(() => {
            expect(screen.getByRole("dialog")).toBeInTheDocument();
        });
    });

    it("Cancel button closes dialog", async () => {
        const user = await openDialog();
        const cancelBtn = await screen.findByRole("button", { name: /cancel/i });
        await user.click(cancelBtn);
        await waitFor(() => {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes dialog", async () => {
        const user = await openDialog();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        await openDialog();
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        await openDialog();
        await screen.findByRole("dialog");
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThan(0);
    });
});
