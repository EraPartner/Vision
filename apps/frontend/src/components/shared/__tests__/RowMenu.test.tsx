// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RowMenu } from "@/components/shared/RowMenu";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

describe("RowMenu", () => {
    it("opens from a labelled trigger without activating the row and marks destructive items", async () => {
        const user = userEvent.setup();
        const onRow = vi.fn();
        const onDelete = vi.fn();
        render(
            <div role="button" tabIndex={0} onClick={onRow}>
                Row
                <RowMenu label="Actions for Rent">
                    <DropdownMenuItem>Edit</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                        Delete
                    </DropdownMenuItem>
                </RowMenu>
            </div>,
        );
        await user.click(
            screen.getByRole("button", { name: "Actions for Rent" }),
        );
        const del = await screen.findByRole("menuitem", { name: "Delete" });
        expect(del).toHaveAttribute("data-variant", "destructive");
        expect(del).toHaveClass("text-destructive");
        await user.click(del);
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(onRow).not.toHaveBeenCalled();
    });
});
