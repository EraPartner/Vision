// @vitest-environment jsdom

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
    DeferredRecipientCombobox,
    RecipientCombobox,
    useRecipientComboboxLabel,
} from "@/components/shared/RecipientCombobox";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, RECIPIENT_STUB } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";
const selectedRecipient = {
    ...RECIPIENT_STUB,
    id: 999,
    name: "Beyond First Page",
};

describe("RecipientCombobox", () => {
    it("forwards field-error ARIA to standard and deferred triggers", () => {
        renderWithApp(
            <>
                <RecipientCombobox
                    aria-label="Standard recipient"
                    aria-invalid
                    aria-describedby="standard-error"
                    onSelect={() => undefined}
                />
                <DeferredRecipientCombobox
                    aria-label="Deferred recipient"
                    aria-invalid
                    aria-describedby="deferred-error"
                    label="Choose recipient"
                    onSelect={() => undefined}
                />
            </>,
        );

        expect(
            screen.getByRole("combobox", { name: "Standard recipient" }),
        ).toHaveAttribute("aria-describedby", "standard-error");
        expect(
            screen.getByRole("combobox", { name: "Standard recipient" }),
        ).toHaveAttribute("aria-invalid", "true");
        expect(
            screen.getByRole("combobox", { name: "Deferred recipient" }),
        ).toHaveAttribute("aria-describedby", "deferred-error");
    });

    it("resolves the selected label independently and clears search when closed", async () => {
        server.use(
            http.get(`${API_BASE}/api/recipients/999`, () =>
                ok(selectedRecipient),
            ),
            http.get(`${API_BASE}/api/recipients`, ({ request }) => {
                const search = new URL(request.url).searchParams.get("search");
                const items = search ? [] : [RECIPIENT_STUB];
                return ok({
                    items,
                    total: items.length,
                    limit: 100,
                    offset: 0,
                    links: [],
                });
            }),
        );
        const onSelect = vi.fn();
        renderWithApp(
            <RecipientCombobox
                aria-label="Recipient"
                value={999}
                onSelect={onSelect}
            />,
        );

        const trigger = screen.getByRole("combobox", { name: "Recipient" });
        expect(
            await screen.findByText("Beyond First Page"),
        ).toBeInTheDocument();

        await userEvent.click(trigger);
        const search = screen.getByPlaceholderText("Search recipients…");
        await userEvent.type(search, "missing");
        await waitFor(() =>
            expect(screen.getByText("Beyond First Page")).toBeInTheDocument(),
        );

        await userEvent.keyboard("{Escape}");
        expect(trigger).toHaveAttribute("aria-expanded", "false");

        await userEvent.click(trigger);
        expect(screen.getByPlaceholderText("Search recipients…")).toHaveValue(
            "",
        );
    });

    it("keeps closed deferred rows on one shared list query without per-id detail requests", async () => {
        let detailRequests = 0;
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [RECIPIENT_STUB],
                    total: 1,
                    limit: 100,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/recipients/:id`, () => {
                detailRequests += 1;
                return ok(RECIPIENT_STUB);
            }),
        );

        function DeferredRows() {
            const labelFor = useRecipientComboboxLabel();
            return (
                <>
                    <DeferredRecipientCombobox
                        aria-label="First deferred recipient"
                        value={RECIPIENT_STUB.id}
                        label={labelFor(RECIPIENT_STUB.id)}
                        onSelect={() => undefined}
                    />
                    <DeferredRecipientCombobox
                        aria-label="Second deferred recipient"
                        value={999}
                        label={labelFor(999)}
                        onSelect={() => undefined}
                    />
                </>
            );
        }

        renderWithApp(<DeferredRows />);
        expect(
            await screen.findByText(RECIPIENT_STUB.name),
        ).toBeInTheDocument();
        expect(detailRequests).toBe(0);
    });
});
