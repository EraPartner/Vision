// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import {
    booleanSearchParamCodec,
    enumSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";

const periodCodec = enumSearchParamCodec(["all", "1m", "1y"] as const, "all");

function Harness() {
    const [period, setPeriod] = useSearchParamState("period", periodCodec);
    const [enabled, setEnabled] = useSearchParamState(
        "enabled",
        booleanSearchParamCodec,
    );
    const location = useLocation();
    return (
        <>
            <output>{`${period}:${enabled}`}</output>
            <button
                onClick={() =>
                    setPeriod((previous) => (previous === "1m" ? "all" : "1m"))
                }
            >
                period
            </button>
            <button onClick={() => setEnabled((previous) => !previous)}>
                enabled
            </button>
            <div data-testid="url">{location.search}</div>
        </>
    );
}

describe("useSearchParamState", () => {
    it("falls back for invalid values without rewriting on mount", () => {
        render(
            <MemoryRouter initialEntries={["/?period=invalid&keep=yes"]}>
                <Harness />
            </MemoryRouter>,
        );
        expect(screen.getByText("all:false")).toBeInTheDocument();
        expect(screen.getByTestId("url")).toHaveTextContent(
            "?period=invalid&keep=yes",
        );
    });

    it("supports functional updates, deletes defaults, and preserves unrelated params", async () => {
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={["/?period=1m&keep=yes"]}>
                <Harness />
            </MemoryRouter>,
        );
        await user.click(screen.getByRole("button", { name: "period" }));
        expect(screen.getByTestId("url")).toHaveTextContent("?keep=yes");
        await user.click(screen.getByRole("button", { name: "enabled" }));
        expect(screen.getByTestId("url")).toHaveTextContent(
            "?keep=yes&enabled=true",
        );
    });
});
