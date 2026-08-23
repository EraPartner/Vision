// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { BulkRecipientDialog } from "@/features/transactions/components/bulk/BulkRecipientDialog";
import { BulkRecategorizeDialog } from "@/features/transactions/components/bulk/BulkRecategorizeDialog";

describe("bulk action dialog field labels", () => {
    it("associates the visible Recipient label with its combobox", async () => {
        renderWithApp(
            <BulkRecipientDialog
                open
                selectedCount={3}
                onOpenChange={vi.fn()}
                onApply={vi.fn()}
            />,
        );

        expect(await screen.findByText("Recipient", { selector: "label" })).toBeVisible();
        expect(screen.getByRole("combobox", { name: "Recipient" })).toHaveAttribute(
            "id",
            "bulk-recipient",
        );
    });

    it("associates the visible Category label with its combobox", async () => {
        renderWithApp(
            <BulkRecategorizeDialog
                open
                selectedCount={3}
                onOpenChange={vi.fn()}
                onApply={vi.fn()}
            />,
        );

        expect(await screen.findByText("Category", { selector: "label" })).toBeVisible();
        expect(screen.getByRole("combobox", { name: "Category" })).toHaveAttribute(
            "id",
            "bulk-category",
        );
    });
});
