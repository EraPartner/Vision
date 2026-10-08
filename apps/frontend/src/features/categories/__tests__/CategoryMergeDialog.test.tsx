// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { CategoryMergeDialog } from "../CategoryMergeDialog";
import type { CategoryNode } from "@/types/api";

it("identifies the full source and selected destination paths before merging", async () => {
    const source = {
        id: 1,
        path: ["Expenses", "Travel"],
        pathIds: [10, 1],
        is_active: true,
    } as CategoryNode;
    const target = {
        id: 2,
        path: ["Expenses", "Holidays"],
        pathIds: [10, 2],
        is_active: true,
    } as CategoryNode;
    const user = userEvent.setup();
    renderWithApp(
        <CategoryMergeDialog
            source={source}
            nodes={[source, target]}
            open
            onOpenChange={vi.fn()}
        />,
    );
    expect(screen.getByText("Expenses / Travel")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(
        await screen.findByRole("option", { name: "Expenses / Holidays" }),
    );
    expect(
        screen.getByText(
            /Merge 'Expenses \/ Travel' into 'Expenses \/ Holidays'/,
        ),
    ).toBeInTheDocument();
});
