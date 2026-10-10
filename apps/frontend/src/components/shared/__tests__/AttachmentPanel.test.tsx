// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { AttachmentPanel } from "@/components/shared/AttachmentPanel";

const API_BASE = "http://localhost:3002";

describe("AttachmentPanel", () => {
    it("names each icon-only delete button after its attachment", async () => {
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

        renderWithApp(<AttachmentPanel transactionId={7} />);

        expect(
            await screen.findByRole("button", {
                name: "Delete attachment receipt.pdf",
            }),
        ).toBeInTheDocument();
    });
});
