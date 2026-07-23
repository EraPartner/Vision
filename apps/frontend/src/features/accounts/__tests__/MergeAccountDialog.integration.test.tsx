// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, ACCOUNT_STUB } from "@/test/msw/handlers";
import { MergeAccountDialog } from "@/features/accounts/MergeAccountDialog";
import type { Account } from "@/types/api";

const API_BASE = "http://localhost:3002";

// ACCOUNT_STUB mirrors the wire shape (null-able optionals), so cast via the
// same unknown hop the other account fixtures use.
const asAccount = (o: object): Account => o as unknown as Account;
const SOURCE = asAccount({ ...ACCOUNT_STUB, id: 1, name: "Old KBC", display_name: "Old KBC" });
const TARGET = asAccount({ ...ACCOUNT_STUB, id: 2, name: "New KBC", display_name: "New KBC" });
const ARCHIVED = asAccount({ ...ACCOUNT_STUB, id: 3, name: "Dusty", display_name: "Dusty", is_active: false });

const PREVIEW = {
    into: 2,
    source: 1,
    reassigned: { transactions: 1002, planned: 3, portfolio: 0, funding: 0 },
    projectedBalance: 1234.56,
    projectedBalanceCurrency: "EUR",
    stampsInterleaved: true,
};

function mockApi({ preview = PREVIEW }: { preview?: typeof PREVIEW | "error" } = {}) {
    const listParams: URLSearchParams[] = [];
    const previewCalls: Array<{ id: string; into: string | null }> = [];
    server.use(
        http.get(`${API_BASE}/api/accounts`, ({ request }) => {
            listParams.push(new URL(request.url).searchParams);
            return ok({ items: [SOURCE, TARGET, ARCHIVED], total: 3, links: [] });
        }),
        http.get(`${API_BASE}/api/accounts/:id/merge-preview`, ({ request, params }) => {
            previewCalls.push({
                id: String(params.id),
                into: new URL(request.url).searchParams.get("into"),
            });
            if (preview === "error") return err(500, "boom");
            return ok(preview);
        }),
    );
    return { listParams, previewCalls };
}

function renderDialog() {
    return renderWithApp(
        <MergeAccountDialog source={SOURCE} open onOpenChange={vi.fn()} />,
    );
}

describe("MergeAccountDialog (integration, WP-B5 §3 F9 preview)", () => {
    it("lists candidates from the FULL population (active: 'all'), labeling archived ones", async () => {
        const { listParams } = mockApi();
        const user = userEvent.setup();
        renderDialog();

        await user.click(await screen.findByRole("combobox", { name: /keep this account/i }));
        // The source itself is never a candidate.
        expect(screen.queryByRole("option", { name: /old kbc/i })).not.toBeInTheDocument();
        expect(await screen.findByRole("option", { name: "New KBC" })).toBeInTheDocument();
        // Archived candidates appear, explicitly labeled.
        expect(screen.getByRole("option", { name: "Dusty (Archived)" })).toBeInTheDocument();

        // Candidates come from the hub-independent full population.
        await waitFor(() => expect(listParams.length).toBeGreaterThan(0));
        expect(listParams.some((p) => p.get("active") === "all")).toBe(true);
    });

    it("shows counts + projected balance + the interleaved-stamp warning once a survivor is chosen", async () => {
        const { previewCalls } = mockApi();
        const user = userEvent.setup();
        renderDialog();

        await user.click(await screen.findByRole("combobox", { name: /keep this account/i }));
        await user.click(await screen.findByRole("option", { name: "New KBC" }));

        // "1.002 transactions + 3 planned will move; resulting balance €X"
        // (counts share the money formatter's eu locale → 1.002).
        expect(await screen.findByText(/1\.002 transactions \+ 3 planned will move/i)).toBeInTheDocument();
        expect(screen.getByText(/resulting balance .*1\.234,56/i)).toBeInTheDocument();
        // Interleaved stamps → the anchor-clearing warning.
        expect(screen.getByText(/merging two stamped accounts — the statement anchor will be cleared/i)).toBeInTheDocument();

        // The dry-run hit the WP-A3 endpoint with source in the path, survivor as ?into=.
        await waitFor(() => expect(previewCalls.length).toBeGreaterThan(0));
        expect(previewCalls[0]).toEqual({ id: "1", into: "2" });
    });

    it("omits the interleaved warning when stamps do not interleave", async () => {
        mockApi({ preview: { ...PREVIEW, stampsInterleaved: false } });
        const user = userEvent.setup();
        renderDialog();

        await user.click(await screen.findByRole("combobox", { name: /keep this account/i }));
        await user.click(await screen.findByRole("option", { name: "New KBC" }));

        expect(await screen.findByText(/will move; resulting balance/i)).toBeInTheDocument();
        expect(screen.queryByText(/statement anchor will be cleared/i)).not.toBeInTheDocument();
    });

    it("keeps the merge available when the preview fails (preview is advisory)", async () => {
        mockApi({ preview: "error" });
        const user = userEvent.setup();
        renderDialog();

        await user.click(await screen.findByRole("combobox", { name: /keep this account/i }));
        await user.click(await screen.findByRole("option", { name: "New KBC" }));

        expect(await screen.findByText(/could not load the merge preview/i)).toBeInTheDocument();
        // Acknowledge + merge still possible: the button only needs target + checkbox.
        await user.click(screen.getByRole("checkbox"));
        expect(screen.getByRole("button", { name: /^merge$/i })).toBeEnabled();
    });
});
