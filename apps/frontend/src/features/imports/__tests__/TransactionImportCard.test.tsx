// @vitest-environment jsdom
/**
 * Custom-mapping CSV import — the two answers `POST /api/import/csv/custom`
 * can give.
 *
 * The 201 case pins the row count the success toast reports. It used to read
 * `total_processed`, a field this route has never put on the wire (the route's
 * count is `total`, `buildPipelineResult` in node-backend
 * routes/importRoutes.js), so the toast rendered "undefined total processed".
 *
 * The 202 case pins the other arm of the union: nothing is committed, the body
 * carries no counts at all, and the outcome is the review page — so no success
 * toast may claim rows were imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, importCsvReviewRequiredHandlers } from "@/test/msw/handlers";
import { TransactionImportCard } from "@/features/imports/TransactionImportCard";

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    },
}));

const { toast } = await import("sonner");

const API_BASE = "http://localhost:3002";

/**
 * A saved parser config is the cheapest route to `isCustomLike`: picking it in
 * the bank select fills the column mapping from the saved config, so the test
 * never has to drive the column mapper.
 */
const SAVED_PARSER = {
    id: 1,
    name: "My Bank",
    config: {
        dateColumn: "Date",
        dateFormat: "%Y-%m-%d",
        recipientColumn: "Description",
        amountColumn: "Amount",
        memoColumn: "",
        separator: ",",
        encoding: "utf-8",
        skipRows: 0,
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
};

function renderCard() {
    return renderWithApp(
        <Routes>
            <Route path="/" element={<TransactionImportCard onImportSuccess={() => {}} />} />
            <Route path="/import/:batchId/review" element={<div>review page for batch</div>} />
        </Routes>,
    );
}

/** Pick the saved parser, attach a CSV, press Import. */
async function runCustomImport(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("combobox", { name: /bank/i }));
    await user.click(await screen.findByRole("option", { name: /My Bank/ }));

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input!, new File(["date,desc,amount\n"], "statement.csv", { type: "text/csv" }));

    await user.click(screen.getByRole("button", { name: /Import Transactions/i }));
}

describe("TransactionImportCard — custom-mapping import", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        server.use(
            http.get(`${API_BASE}/api/import/parsers`, () => ok({ items: [SAVED_PARSER], total: 1 })),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("reports the route's real row count in the success toast on 201", async () => {
        const user = userEvent.setup();
        renderCard();
        await runCustomImport(user);

        await waitFor(() => expect(toast.success).toHaveBeenCalled());

        // IMPORT_CSV_RESULT_STUB: total 3, imported 2, duplicates 1.
        const message = vi.mocked(toast.success).mock.calls[0][0] as string;
        expect(message).toBe("Imported 2 transactions (1 duplicates skipped, 3 total processed)");
        expect(message).not.toContain("undefined");
    });

    it("routes to the review page and claims no import on 202", async () => {
        server.use(...importCsvReviewRequiredHandlers);

        const user = userEvent.setup();
        renderCard();
        await runCustomImport(user);

        // IMPORT_CSV_REVIEW_REQUIRED_STUB.batch_id === 7
        expect(await screen.findByText("review page for batch")).toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
    });
});
