// @vitest-environment jsdom
/**
 * The onboarding wizard's import step — both answers `POST /api/import/csv`
 * can give, driven through the real wizard rather than asserted on the handler.
 *
 * The 202 arm is the one that matters here, and it is not an edge case on this
 * screen: `prepareImport` (node-backend services/importPipeline/index.js:78-84)
 * requires review as soon as any row resolves to a NEW recipient, and on a
 * first run the database is empty, so every recipient is new. The wizard used
 * to render that branch as a green "0 transactions imported" tick — a success
 * screen for a batch that had committed nothing. These tests pin the replacement:
 * a "needs your review" state that names the row count, claims no import, and
 * carries the user to `/import/:batchId/review`.
 *
 * The 201 arm is kept alongside it as a regression guard for the count fix that
 * landed with the contract narrowing — the success screen must still report the
 * route's real `imported` / `duplicates`, never `undefined` and never 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, importCsvReviewRequiredHandlers } from "@/test/msw/handlers";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

vi.mock("sonner", () => {
    const base = vi.fn();
    return {
        toast: Object.assign(base, {
            success: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warning: vi.fn(),
            message: vi.fn(),
            loading: vi.fn(),
            dismiss: vi.fn(),
            custom: vi.fn(),
        }),
        Toaster: () => null,
    };
});

const { toast } = await import("sonner");

const API_BASE = "http://localhost:3002";

function renderWizard(onComplete = vi.fn()) {
    const result = renderWithApp(
        <Routes>
            <Route
                path="/"
                element={<OnboardingWizard open={true} onComplete={onComplete} />}
            />
            <Route path="/import/:batchId/review" element={<div>review page stub</div>} />
        </Routes>,
    );
    return { ...result, onComplete };
}

/** welcome -> overview -> bank, pick KBC, -> import, attach a CSV, press Import. */
async function runOnboardingImport(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /get started/i }));
    await user.click(await screen.findByRole("button", { name: /^next$/i }));

    // A bank must be picked: the import button stays disabled without one.
    await user.click(await screen.findByRole("button", { name: /^kbc$/i }));
    await user.click(await screen.findByRole("button", { name: /^next$/i }));
    await screen.findByRole("heading", { name: /import your transactions/i });

    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(inputs).toHaveLength(1);
    await user.upload(
        inputs[0],
        new File(["date,desc,amount\n"], "statement.csv", { type: "text/csv" }),
    );

    await user.click(await screen.findByRole("button", { name: /^import transactions$/i }));
}

describe("OnboardingWizard — import step outcomes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        server.use(
            http.get(`${API_BASE}/api/info/supported-adapters`, () =>
                ok({
                    items: [
                        { key: "kbc", name: "KBC", adapter_class: "KbcAdapter" },
                        { key: "ing", name: "ING", adapter_class: "IngAdapter" },
                    ],
                    total: 2,
                }),
            ),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("offers the review page instead of a success tick on 202", async () => {
        server.use(...importCsvReviewRequiredHandlers);
        const user = userEvent.setup();
        const { onComplete } = renderWizard();

        await runOnboardingImport(user);

        // IMPORT_CSV_REVIEW_REQUIRED_STUB.match_source_counts sums to 4.
        expect(await screen.findByText("4 transactions are waiting for you")).toBeInTheDocument();
        // Nothing was committed, so nothing may claim it was.
        expect(screen.queryByText(/transactions imported/i)).not.toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.info).toHaveBeenCalledWith(
            "4 transactions are ready — review them to finish the import",
        );

        // The affordance the bug was missing, and where it goes.
        const review = screen.getByRole("button", { name: /review and finish import/i });
        await user.click(review);

        // IMPORT_CSV_REVIEW_REQUIRED_STUB.batch_id === 7
        expect(await screen.findByText("review page stub")).toBeInTheDocument();
        // Onboarding is closed out before the hand-off, otherwise the modal would
        // still be sitting on top of the page we just navigated to.
        expect(onComplete).toHaveBeenCalled();
    });

    it("still ends at the pending batch when the user finishes setup first", async () => {
        server.use(...importCsvReviewRequiredHandlers);
        const user = userEvent.setup();
        const { onComplete } = renderWizard();

        await runOnboardingImport(user);
        await screen.findByText("4 transactions are waiting for you");

        // import -> categories -> tour -> backup
        for (let i = 0; i < 3; i++) {
            await user.click(await screen.findByRole("button", { name: /^next$/i }));
        }
        await screen.findByRole("heading", { name: /protect your data/i });

        // The wizard's last CTA is the batch, not the dashboard.
        expect(screen.queryByRole("button", { name: /go to dashboard/i })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /finish your import/i }));

        expect(await screen.findByText("review page stub")).toBeInTheDocument();
        expect(onComplete).toHaveBeenCalled();
    });

    it("reports the route's real counts on the 201 committed path", async () => {
        const user = userEvent.setup();
        renderWizard();

        await runOnboardingImport(user);

        // IMPORT_CSV_RESULT_STUB: imported 2, duplicates 1.
        expect(await screen.findByText("2 transactions imported")).toBeInTheDocument();
        expect(screen.getByText("1 duplicates skipped.")).toBeInTheDocument();
        expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Imported 2 transactions"));
        expect(toast.info).not.toHaveBeenCalled();

        // The 201 path must not offer a review hand-off — the batch is committed.
        expect(screen.queryByRole("button", { name: /review and finish import/i })).not.toBeInTheDocument();
    });
});
