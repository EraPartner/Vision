// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { ImportHistoryCard } from "@/features/imports/ImportHistoryCard";
import type { ImportBatch } from "@/lib/api/types";

const API_BASE = "http://localhost:3002";

function makeBatch(overrides: Partial<ImportBatch> = {}): ImportBatch {
    return {
        id: 1,
        adapter_name: "kbc",
        source_filename: "transactions.csv",
        source_size_bytes: 1024,
        status: "complete",
        rows_total: 10,
        rows_imported: 8,
        rows_duplicate: 1,
        rows_error: 1,
        error_summary: null,
        started_at: "2025-01-15T10:00:00.000Z",
        completed_at: "2025-01-15T10:00:30.000Z",
        transactions_remaining: 8,
        ...overrides,
    };
}

describe("ImportHistoryCard", () => {
    it("renders the title and description", async () => {
        renderWithApp(<ImportHistoryCard />);
        expect(await screen.findByText(/import history/i)).toBeInTheDocument();
        expect(
            await screen.findByText(/recent csv imports/i),
        ).toBeInTheDocument();
    });

    it("shows empty state when no batches exist", async () => {
        renderWithApp(<ImportHistoryCard />);
        expect(await screen.findByText(/no imports yet/i)).toBeInTheDocument();
    });

    it("renders batch rows when batches are returned", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                ok({
                    items: [
                        makeBatch({ id: 1, source_filename: "jan.csv" }),
                        makeBatch({
                            id: 2,
                            source_filename: "feb.csv",
                            adapter_name: "ing",
                        }),
                    ],
                    total: 2,
                }),
            ),
        );

        renderWithApp(<ImportHistoryCard />);

        expect(await screen.findByText("jan.csv")).toBeInTheDocument();
        expect(await screen.findByText("feb.csv")).toBeInTheDocument();
        expect(await screen.findByText("kbc")).toBeInTheDocument();
        expect(await screen.findByText("ing")).toBeInTheDocument();
    });

    it("renders rollback button only for completed batches with remaining transactions", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                ok({
                    items: [
                        makeBatch({
                            id: 1,
                            source_filename: "rollbackable.csv",
                            status: "complete",
                            transactions_remaining: 5,
                        }),
                        makeBatch({
                            id: 2,
                            source_filename: "failed.csv",
                            status: "failed",
                            transactions_remaining: 0,
                        }),
                    ],
                    total: 2,
                }),
            ),
        );

        renderWithApp(<ImportHistoryCard />);

        await screen.findByText("rollbackable.csv");
        await screen.findByText("failed.csv");

        const rollbackButtons = screen.getAllByRole("button", {
            name: /rollback/i,
        });
        expect(rollbackButtons).toHaveLength(1);
    });

    it("opens the rollback confirmation dialog when rollback is clicked", async () => {
        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                ok({
                    items: [
                        makeBatch({
                            id: 7,
                            source_filename: "march.csv",
                            transactions_remaining: 3,
                        }),
                    ],
                    total: 1,
                }),
            ),
        );

        const user = userEvent.setup();
        renderWithApp(<ImportHistoryCard />);

        const rollbackBtn = await screen.findByRole("button", {
            name: /rollback/i,
        });
        await user.click(rollbackBtn);

        const dialog = await screen.findByRole("alertdialog");
        expect(
            within(dialog).getByText(/roll back import/i),
        ).toBeInTheDocument();
        expect(
            within(dialog).getByText(/march\.csv/i),
        ).toBeInTheDocument();
    });

    it("performs rollback and refreshes the list when confirmed", async () => {
        let listCalls = 0;
        const deleteSpy = vi.fn();

        server.use(
            http.get(`${API_BASE}/api/import/batches`, () => {
                listCalls += 1;
                return ok({
                    items: [
                        makeBatch({
                            id: 42,
                            source_filename: "rollback-me.csv",
                            transactions_remaining: 4,
                        }),
                    ],
                    total: 1,
                });
            }),
            http.delete(
                `${API_BASE}/api/import/batches/:batchId`,
                ({ params }) => {
                    deleteSpy(params.batchId);
                    return ok({ deleted: 4 });
                },
            ),
        );

        const user = userEvent.setup();
        renderWithApp(<ImportHistoryCard />);

        const rollbackBtn = await screen.findByRole("button", {
            name: /rollback/i,
        });
        await user.click(rollbackBtn);

        const confirmBtn = await screen.findByRole("button", {
            name: /yes, roll back/i,
        });
        const initialCalls = listCalls;
        await user.click(confirmBtn);

        await waitFor(() => {
            expect(deleteSpy).toHaveBeenCalledWith("42");
        });
        await waitFor(() => {
            expect(listCalls).toBeGreaterThan(initialCalls);
        });
    });

    it("cancels rollback when cancel is clicked without calling DELETE", async () => {
        const deleteSpy = vi.fn();

        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                ok({
                    items: [
                        makeBatch({
                            id: 99,
                            source_filename: "keep.csv",
                            transactions_remaining: 2,
                        }),
                    ],
                    total: 1,
                }),
            ),
            http.delete(`${API_BASE}/api/import/batches/:batchId`, () => {
                deleteSpy();
                return ok({ deleted: 0 });
            }),
        );

        const user = userEvent.setup();
        renderWithApp(<ImportHistoryCard />);

        const rollbackBtn = await screen.findByRole("button", {
            name: /rollback/i,
        });
        await user.click(rollbackBtn);

        const cancelBtn = await screen.findByRole("button", {
            name: /^cancel$/i,
        });
        await user.click(cancelBtn);

        await waitFor(() => {
            expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        });
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("renders pagination controls when total exceeds page size", async () => {
        const manyBatches = Array.from({ length: 10 }, (_, i) =>
            makeBatch({
                id: i + 1,
                source_filename: `file-${i + 1}.csv`,
                transactions_remaining: 0,
            }),
        );

        server.use(
            http.get(`${API_BASE}/api/import/batches`, () =>
                ok({ items: manyBatches, total: 25 }),
            ),
        );

        renderWithApp(<ImportHistoryCard />);

        await screen.findByText("file-1.csv");
        expect(
            await screen.findByRole("button", { name: /previous/i }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("button", { name: /next/i }),
        ).toBeInTheDocument();
        expect(await screen.findByText(/page 1 of 3/i)).toBeInTheDocument();
    });
});
