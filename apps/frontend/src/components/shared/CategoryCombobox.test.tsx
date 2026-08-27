// @vitest-environment jsdom

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";

describe("CategoryCombobox", () => {
    it("requests the complete list and filters a category beyond the old cap", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        let requestUrl = "";
        const categories = Array.from({ length: 202 }, (_, index) => ({
            id: index + 1,
            general: index === 201 ? "SPECIAL" : "GENERAL",
            detail:
                index === 201 ? "Archived receipts" : `Category ${index + 1}`,
            description: null,
            is_active: true,
            created_at: "2025-01-01T00:00:00Z",
            links: [],
        }));

        server.use(
            http.get(`${API_BASE}/api/categories`, ({ request }) => {
                requestUrl = request.url;
                return ok({
                    items: categories,
                    total: categories.length,
                    links: [],
                });
            }),
        );

        renderWithApp(
            <CategoryCombobox aria-label="Category" onSelect={onSelect} />,
        );

        await waitFor(() => expect(requestUrl).not.toBe(""));
        expect(new URL(requestUrl).searchParams.has("limit")).toBe(false);

        await user.click(screen.getByRole("combobox", { name: "Category" }));
        await user.type(
            screen.getByPlaceholderText(/search categories/i),
            "Archived receipts",
        );
        await user.click(
            await screen.findByRole("option", {
                name: "SPECIAL: Archived receipts",
            }),
        );

        expect(onSelect).toHaveBeenCalledWith(
            202,
            "SPECIAL: Archived receipts",
        );
    });
});
