// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { AttachmentPanel } from "@/components/shared/AttachmentPanel";
import { downloadBlob } from "@/lib/downloadBlob";
import { asTransactionId } from "@vision/types/brands";

vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: vi.fn() }));

const API_BASE = "http://localhost:3002";

function serveAttachmentList() {
    server.use(
        http.get(`${API_BASE}/api/attachments/transaction/7`, () =>
            ok({
                items: [
                    {
                        id: "3",
                        transaction_id: 7,
                        filename: "receipt.pdf",
                        stored_path: "attachments/receipt.pdf",
                        mime_type: "application/pdf",
                        size_bytes: 2048,
                        created_at: "2026-01-01T00:00:00Z",
                    },
                ],
                total: 1,
            }),
        ),
    );
}

describe("AttachmentPanel", () => {
    it("names each icon-only delete button after its attachment", async () => {
        serveAttachmentList();

        renderWithApp(<AttachmentPanel transactionId={asTransactionId(7)} />);

        expect(
            await screen.findByRole("button", {
                name: "Delete attachment receipt.pdf",
            }),
        ).toBeInTheDocument();
    });

    it("downloads the attachment bytes in place instead of opening a new window", async () => {
        serveAttachmentList();
        server.use(
            http.get(
                `${API_BASE}/api/attachments/3/download`,
                () =>
                    new HttpResponse("%PDF-1.7 receipt", {
                        headers: { "Content-Type": "application/pdf" },
                    }),
            ),
        );
        const user = userEvent.setup();

        renderWithApp(<AttachmentPanel transactionId={asTransactionId(7)} />);
        const download = await screen.findByRole("button", {
            name: "Download attachment receipt.pdf",
        });
        expect(screen.queryByRole("link")).not.toBeInTheDocument();

        await user.click(download);

        await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
        const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0] ?? [];
        expect(filename).toBe("receipt.pdf");
        expect(blob?.size).toBe("%PDF-1.7 receipt".length);
    });
});
