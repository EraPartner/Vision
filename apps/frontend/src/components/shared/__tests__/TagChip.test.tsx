// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TagChip } from "@/components/shared/TagInput";

describe("TagChip", () => {
    it("expands the remove control hit area without changing the visible icon", () => {
        render(
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

        const remove = screen.getByRole("button", { name: "Remove tag travel" });
        expect(remove).toHaveClass("p-3.5", "-m-3.5");
        expect(remove.querySelector("svg")).toHaveClass("h-3", "w-3");
    });
});
