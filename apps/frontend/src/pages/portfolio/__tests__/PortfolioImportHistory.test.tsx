// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { PortfolioImportHistory } from "../PortfolioImportHistory";

const api = "http://localhost:3002/api/portfolio/import/batches";
const restored = vi.fn();
const busy = vi.fn();
let deletes = 0;
let aborted = false;
async function renderHistory(disabled = false) {
    renderWithApp(
        <PortfolioImportHistory
            disabled={disabled}
            onBusyChange={busy}
            onRolledBack={restored}
        />,
    );
    await userEvent.setup().click(await screen.findByText("Import history"));
}
beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    deletes = 0;
    aborted = false;
    server.use(
        http.get(api, () =>
            ok({
                items: [
                    {
                        id: 8,
                        adapter_name: "nexo_pro_spot_history",
                        source_filename: "synthetic-pro.csv",
                        status: aborted ? "aborted" : "complete",
                        rows_total: 1,
                        rows_error: 0,
                    },
                    {
                        id: 9,
                        adapter_name: "nexo_pro_spot_history",
                        source_filename: "pending.csv",
                        status: "awaiting_review",
                        rows_total: 1,
                        rows_error: 0,
                    },
                ],
                total: 2,
                limit: 10,
                offset: 0,
            }),
        ),
        http.delete(`${api}/8`, () => {
            deletes++;
            aborted = true;
            return ok({ deleted: 0 });
        }),
    );
});
describe("portfolio statement rollback", () => {
    it("requires confirmation and cancellation leaves history untouched", async () => {
        const user = userEvent.setup();
        await renderHistory();
        await user.click(
            await screen.findByRole("button", { name: "Roll back statement" }),
        );
        expect(
            screen.getByText(/Restore adopted records to their values/),
        ).toBeInTheDocument();
        expect(deletes).toBe(0);
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(restored).not.toHaveBeenCalled();
        expect(deletes).toBe(0);
        expect(busy).toHaveBeenLastCalledWith(false);
    });
    it("restores an adoption-only statement and refreshes its terminal status", async () => {
        const user = userEvent.setup();
        await renderHistory();
        await user.click(
            await screen.findByRole("button", { name: "Roll back statement" }),
        );
        await user.click(
            screen
                .getAllByRole("button", { name: "Roll back statement" })
                .find((button) => button.closest('[role="alertdialog"]'))!,
        );
        await waitFor(() => expect(restored).toHaveBeenCalledWith(8));
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: "Roll back statement" }),
            ).not.toBeInTheDocument(),
        );
        expect(deletes).toBe(1);
        expect(busy).toHaveBeenLastCalledWith(false);
    });
    it("keeps the statement available after a rollback conflict", async () => {
        server.use(
            http.delete(`${api}/8`, () => err(409, "Affected history changed")),
        );
        const user = userEvent.setup();
        await renderHistory();
        await user.click(
            await screen.findByRole("button", { name: "Roll back statement" }),
        );
        await user.click(
            screen
                .getAllByRole("button", { name: "Roll back statement" })
                .find((button) => button.closest('[role="alertdialog"]'))!,
        );
        await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
        expect(restored).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: "Roll back statement" }),
        ).toBeEnabled();
    });
    it("disables rollback while another import action is running", async () => {
        await renderHistory(true);
        expect(
            await screen.findByRole("button", { name: "Roll back statement" }),
        ).toBeDisabled();
    });
});
