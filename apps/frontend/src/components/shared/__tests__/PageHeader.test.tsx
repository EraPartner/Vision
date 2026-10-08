// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "@/components/shared/PageHeader";
import { renderWithApp } from "@/test/renderWithApp";

describe("PageHeader back slot", () => {
    it("renders a back link before the title", () => {
        renderWithApp(
            <PageHeader
                title="Checking"
                back={{ label: "Back to accounts", to: "/accounts" }}
            />,
        );
        const back = screen.getByRole("link", { name: "Back to accounts" });
        expect(back).toHaveAttribute("href", "/accounts");
        expect(
            back.compareDocumentPosition(
                screen.getByRole("heading", { name: "Checking" }),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("renders a back button when given a handler", async () => {
        const user = userEvent.setup();
        const onClick = vi.fn();
        renderWithApp(
            <PageHeader title="Alice" back={{ label: "Back", onClick }} />,
        );
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
