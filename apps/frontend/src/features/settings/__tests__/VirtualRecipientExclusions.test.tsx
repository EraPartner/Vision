// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { VirtualRecipientExclusions } from "../VirtualRecipientExclusions";

describe("virtual recipient exclusions", () => {
    afterEach(() => vi.restoreAllMocks());
    it("bounds mounted checkboxes for 1000 recipients and navigates to the last entry", async () => {
        vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect",
        ).mockImplementation(function (this: HTMLElement) {
            return {
                width: 300,
                height: this.hasAttribute("data-radix-scroll-area-viewport")
                    ? 200
                    : 40,
                top: 0,
                left: 0,
                right: 300,
                bottom: 200,
                x: 0,
                y: 0,
                toJSON() {},
            };
        });
        vi.spyOn(
            HTMLElement.prototype,
            "offsetHeight",
            "get",
        ).mockImplementation(function (this: HTMLElement) {
            return this.hasAttribute("data-radix-scroll-area-viewport")
                ? 200
                : 40;
        });
        const recipients = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            name: `Recipient ${i + 1}`,
            is_active: true,
        }));
        const toggle = vi.fn();
        render(
            <VirtualRecipientExclusions
                recipients={recipients}
                excluded={new Set([1])}
                onToggle={toggle}
                label="Excluded recipients"
                hiddenLabel="Hidden"
            />,
        );
        expect(screen.getAllByRole("checkbox").length).toBeLessThan(20);
        const first = screen.getByRole("checkbox", { name: "Recipient 1" });
        expect(first).toHaveAttribute("aria-checked", "true");
        act(() => first.focus());
        fireEvent.keyDown(first, { key: "End" });
        const last = await screen.findByRole("checkbox", {
            name: "Recipient 1000",
        });
        await waitFor(() => expect(last).toHaveFocus());
        fireEvent.click(last);
        expect(toggle).toHaveBeenCalledWith(1000);
        expect(screen.getAllByRole("checkbox").length).toBeLessThan(20);
    });
});
