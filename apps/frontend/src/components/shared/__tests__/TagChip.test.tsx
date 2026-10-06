// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { TagChip } from "@/components/shared/TagInput";

describe("TagChip", () => {
    it("expands the remove control hit area without changing the visible icon", async () => {
        // The remove label is translated, so render inside the app's language
        // provider and wait for the English dictionary.
        renderWithApp(
            <TagChip
                tag={{
                    id: 1,
                    slug: "travel",
                    color: null,
                    is_active: true,
                    created_at: "2026-01-01",
                    updated_at: "2026-01-01",
                }}
                onRemove={vi.fn()}
            />,
        );

        const remove = await screen.findByRole("button", {
            name: "Remove tag travel",
        });
        expect(remove).toHaveClass("p-3.5", "-m-3.5");
        expect(remove.querySelector("svg")).toHaveClass("h-3", "w-3");
    });
});
