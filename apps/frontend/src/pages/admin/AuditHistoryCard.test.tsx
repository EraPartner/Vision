// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElectronAuditBridge } from "@vision/types/electron";
import { renderWithApp } from "@/test/renderWithApp";
import { AuditHistoryCard } from "./AuditHistoryCard";

const HASH = "0".repeat(64);
const entry = (
    sequence: number,
    anchorStatus: "anchored" | "pending_anchor",
) => ({
    sequence,
    version: 1,
    previousHash: HASH,
    hash: HASH,
    payload: { stream: "split", event: "create" },
    createdAt: "2026-09-20T00:00:00.000Z",
    anchorStatus,
});

function installBridge(
    read: ReturnType<typeof vi.fn>,
    exportSnapshot = vi.fn().mockResolvedValue({ success: true }),
    enroll = vi
        .fn()
        .mockResolvedValue({ success: true, enrollmentSequence: 1 }),
) {
    window.electronAudit = {
        enroll,
        read,
        exportSnapshot,
    } as unknown as ElectronAuditBridge;
    return { read, exportSnapshot, enroll };
}

afterEach(() => {
    delete window.electronAudit;
});

describe("AuditHistoryCard", () => {
    it("safely reports unavailable outside Electron", async () => {
        renderWithApp(<AuditHistoryCard />);
        expect(
            await screen.findByText(/verified audit history is unavailable/i),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /export snapshot/i }),
        ).not.toBeInTheDocument();
    });

    it("explains an existing installation without a trusted checkpoint", async () => {
        const read = vi
            .fn()
            .mockResolvedValueOnce({
                success: false,
                status: "unavailable",
                reason: "no_trusted_anchor",
            })
            .mockResolvedValueOnce({
                success: true,
                verification: {
                    status: "verified",
                    sequence: 1,
                    hash: HASH,
                    anchoredThrough: 1,
                    enrollmentSequence: 1,
                },
                entries: [entry(1, "anchored")],
                hasMore: false,
            });
        const { enroll } = installBridge(read);
        renderWithApp(<AuditHistoryCard />);
        expect(
            await screen.findByText(/no trusted audit checkpoint/i),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /export snapshot/i }),
        ).not.toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: /start audit protection/i }),
        );
        expect(enroll).toHaveBeenCalledOnce();
        expect(
            await screen.findByText(/accepted at enrollment/i),
        ).toBeInTheDocument();
    });

    it("separates anchored and pending entries and pages using the last sequence", async () => {
        const read = vi
            .fn()
            .mockResolvedValueOnce({
                success: true,
                verification: {
                    status: "partially_verified",
                    sequence: 2,
                    hash: HASH,
                    anchoredThrough: 1,
                    legacyUnverified: {
                        dbEditor: "3",
                        split: "2",
                        portfolioRetag: "1",
                    },
                },
                entries: [entry(1, "anchored")],
                hasMore: true,
            })
            .mockResolvedValueOnce({
                success: true,
                verification: {
                    status: "partially_verified",
                    sequence: 2,
                    hash: HASH,
                    anchoredThrough: 1,
                    legacyUnverified: {
                        dbEditor: "3",
                        split: "2",
                        portfolioRetag: "1",
                    },
                },
                entries: [entry(2, "pending_anchor")],
                hasMore: false,
            });
        installBridge(read);
        renderWithApp(<AuditHistoryCard />);

        expect(
            await screen.findByText(/anchored through entry 1/i),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/1 newer entries are not yet anchored/i),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                /database editor 3, splits 2, portfolio retags 1/i,
            ),
        ).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: /load more/i }),
        );
        expect(
            await screen.findByText("Pending local receipt"),
        ).toBeInTheDocument();
        expect(screen.getByText("Anchored")).toBeInTheDocument();
        expect(read).toHaveBeenNthCalledWith(2, {
            afterSequence: 1,
            limit: 100,
        });
    });

    it("clears displayed history when refresh verification fails", async () => {
        const read = vi
            .fn()
            .mockResolvedValueOnce({
                success: true,
                verification: {
                    status: "verified",
                    sequence: 1,
                    hash: HASH,
                    anchoredThrough: 1,
                },
                entries: [entry(1, "anchored")],
                hasMore: false,
            })
            .mockResolvedValueOnce({ success: false, status: "failed" });
        installBridge(read);
        renderWithApp(<AuditHistoryCard />);

        expect(
            await screen.findByText(/verified through entry 1/i),
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            /verification failed/i,
        );
        expect(
            screen.queryByText(/verified through entry 1/i),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /export snapshot/i }),
        ).not.toBeInTheDocument();
    });

    it("exports an eligible complete snapshot through Electron", async () => {
        const read = vi.fn().mockResolvedValue({
            success: true,
            verification: {
                status: "verified",
                sequence: 1,
                hash: HASH,
                anchoredThrough: 1,
            },
            entries: [entry(1, "anchored")],
            hasMore: false,
        });
        const { exportSnapshot } = installBridge(read);
        renderWithApp(<AuditHistoryCard />);

        expect(
            await screen.findByText(/verified through entry 1/i),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/not independently protected evidence/i),
        ).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: /export snapshot/i }),
        );
        expect(exportSnapshot).toHaveBeenCalledOnce();
        expect(
            await screen.findByText(/audit snapshot saved/i),
        ).toBeInTheDocument();
    });

    it("disables export beyond 500 entries and reports a changing chain during paging", async () => {
        const read = vi
            .fn()
            .mockResolvedValueOnce({
                success: true,
                verification: {
                    status: "partially_verified",
                    sequence: 501,
                    hash: HASH,
                    anchoredThrough: 500,
                },
                entries: [entry(1, "anchored")],
                hasMore: true,
            })
            .mockResolvedValueOnce({
                success: true,
                verification: {
                    status: "partially_verified",
                    sequence: 502,
                    hash: HASH,
                    anchoredThrough: 500,
                },
                entries: [entry(2, "anchored")],
                hasMore: true,
            });
        const { exportSnapshot } = installBridge(read);
        renderWithApp(<AuditHistoryCard />);

        expect(
            await screen.findByText(/complete export is unavailable/i),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /export snapshot/i }),
        ).toBeDisabled();
        await userEvent.click(
            screen.getByRole("button", { name: /load more/i }),
        );
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                /history changed/i,
            ),
        );
        expect(
            screen.queryByText(/anchored through entry 500/i),
        ).not.toBeInTheDocument();
        expect(exportSnapshot).not.toHaveBeenCalled();
    });
});
