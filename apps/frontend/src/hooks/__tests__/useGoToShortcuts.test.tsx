// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGoToShortcuts } from "@/hooks/useGoToShortcuts";

function Probe() {
    useGoToShortcuts();
    const location = useLocation();
    return (
        <>
            <output data-testid="location">{location.pathname}</output>
            <input aria-label="Draft" />
        </>
    );
}

function setup() {
    render(
        <MemoryRouter initialEntries={["/accounts"]}>
            <Probe />
        </MemoryRouter>,
    );
}

function press(
    key: string,
    target: Document | HTMLElement = document,
    modifiers = {},
) {
    fireEvent.keyDown(target, { key, ...modifiers });
}

afterEach(() => vi.useRealTimers());

describe("go-to navigation shortcuts", () => {
    it.each([
        ["h", "/"],
        ["t", "/transactions"],
        ["c", "/categories"],
        ["y", "/recipients"],
        ["i", "/statistics"],
        ["e", "/import"],
        ["p", "/portfolio"],
        ["n", "/portfolio/net-worth"],
        ["m", "/research/markets"],
        ["a", "/ai-chat"],
    ])("G %s reaches %s", (key, url) => {
        setup();
        press("g");
        press(key);
        expect(screen.getByTestId("location")).toHaveTextContent(url);
        expect(screen.getByTestId("location").textContent).toBe(url);
    });

    it.each(["s", "r"])("retires the old G %s binding", (key) => {
        setup();
        press("g");
        press(key);
        expect(screen.getByTestId("location").textContent).toBe("/accounts");
    });

    it("does not hijack typing or keep a sequence armed after typing", () => {
        setup();
        const input = screen.getByRole("textbox", { name: "Draft" });
        press("g", input);
        press("i", input);
        press("g");
        press("i", input);
        press("i");
        expect(screen.getByTestId("location").textContent).toBe("/accounts");
    });

    it.each(["dialog", "alertdialog"])(
        "stays inert with an open %s",
        (role) => {
            setup();
            const overlay = document.createElement("div");
            overlay.setAttribute("role", role);
            overlay.setAttribute("data-state", "open");
            document.body.append(overlay);
            try {
                press("g");
                press("i");
                expect(screen.getByTestId("location").textContent).toBe(
                    "/accounts",
                );
            } finally {
                overlay.remove();
            }
        },
    );

    it.each(["ctrlKey", "metaKey", "altKey"])(
        "ignores %s combinations",
        (modifier) => {
            setup();
            press("g");
            press("i", document, { [modifier]: true });
            press("i");
            expect(screen.getByTestId("location").textContent).toBe(
                "/accounts",
            );
        },
    );

    it("expires incomplete sequences", () => {
        vi.useFakeTimers();
        setup();
        press("g");
        act(() => {
            vi.advanceTimersByTime(901);
        });
        press("i");
        expect(screen.getByTestId("location").textContent).toBe("/accounts");
    });
});
