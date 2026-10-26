// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { NeedsAttentionList } from "../NeedsAttentionList";
import { asCurrencyCode } from "@vision/types/brands";
import { must } from "@/test/must";

const state = vi.hoisted(() => ({
    accounts: [] as Array<{
        account_id: number;
        bank_account: string;
        display_name: string;
        last_transaction: string;
    }>,
    needsCategory: 2,
}));
vi.mock("../useDashboardQueries", () => ({
    useBankBalances: () => ({ data: { accounts: state.accounts } }),
}));
vi.mock("@/hooks/useNeedsCategoryCount", () => ({
    useNeedsCategoryCount: () => ({ data: state.needsCategory }),
}));
vi.mock("@/hooks/usePlannedMatchSuggestions", () => ({
    usePlannedMatchSuggestions: () => ({
        suggestions: [{ planned: { recipient_name: "Monthly bill" } }],
    }),
}));

const KEY = LOCAL_STORAGE_KEYS.DISMISSED_ACCOUNT_INACTIVITY;
function Harness() {
    const location = useLocation();
    return (
        <>
            <output data-testid="location">{location.pathname}</output>
            <NeedsAttentionList currency={asCurrencyCode("EUR")} />
        </>
    );
}
function account(id: number, last_transaction = "2020-01-01") {
    return {
        account_id: id,
        bank_account: `Account ${id}`,
        display_name: `Friendly ${id}`,
        last_transaction,
    };
}
beforeEach(() => {
    localStorage.removeItem(KEY);
    state.accounts = [account(1), account(2)];
    state.needsCategory = 2;
});
afterEach(() => vi.restoreAllMocks());

describe("Home inactivity alerts", () => {
    it("dismisses by keyboard without navigating, persists after remount, and restores without suppressing other attention items", async () => {
        const user = userEvent.setup();
        const first = renderWithApp(<Harness />);
        const dismiss = await screen.findByRole("button", {
            name: "Dismiss inactivity alert for Friendly 1",
        });
        expect(dismiss.closest("a")).toBeNull();
        dismiss.focus();
        await user.keyboard("{Enter}");
        expect(
            screen.queryByRole("link", {
                name: /Friendly 1 has no transactions/,
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("link", {
                name: /Friendly 2 has no transactions/,
            }),
        ).toHaveAttribute("href", "/import");
        expect(
            screen.getByRole("link", {
                name: /2 transactions need a category/,
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /1 planned payment looks paid/ }),
        ).toBeInTheDocument();
        expect(screen.getByTestId("location")).toHaveTextContent("/");
        expect(JSON.parse(must(localStorage.getItem(KEY)))).toEqual({
            "1": "2020-01-01",
        });
        first.unmount();
        renderWithApp(<Harness />);
        expect(
            await screen.findByRole("button", {
                name: "Restore dismissed alerts",
            }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("link", {
                name: /Friendly 1 has no transactions/,
            }),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: "Restore dismissed alerts" }),
        );
        expect(
            await screen.findByRole("link", {
                name: /Friendly 1 has no transactions/,
            }),
        ).toBeInTheDocument();
    });

    it("keeps a renamed account dismissed until its last transaction day changes", async () => {
        const user = userEvent.setup();
        const view = renderWithApp(<Harness />);
        await user.click(
            await screen.findByRole("button", {
                name: "Dismiss inactivity alert for Friendly 1",
            }),
        );
        state.accounts = [
            { ...account(1, "2020-01-01T12:00:00Z"), display_name: "Renamed" },
        ];
        view.rerender(<Harness />);
        expect(
            screen.queryByRole("button", { name: /Dismiss inactivity alert/ }),
        ).not.toBeInTheDocument();
        state.accounts = [
            { ...account(1, "2020-02-01"), display_name: "Renamed" },
        ];
        view.rerender(<Harness />);
        expect(
            await screen.findByRole("button", {
                name: "Dismiss inactivity alert for Renamed",
            }),
        ).toBeInTheDocument();
    });

    it("fills the three visible slots after dismissing an alert without mutating account data", async () => {
        state.accounts = [account(1), account(2), account(3), account(4)];
        const user = userEvent.setup();
        renderWithApp(<Harness />);
        await user.click(
            await screen.findByRole("button", {
                name: "Dismiss inactivity alert for Friendly 1",
            }),
        );
        expect(
            await screen.findByRole("button", {
                name: "Dismiss inactivity alert for Friendly 4",
            }),
        ).toBeInTheDocument();
        expect(state.accounts.map((a) => a.account_id)).toEqual([1, 2, 3, 4]);
    });

    it.each(["not json", "null", "[]", '{"1":true}'])(
        "ignores malformed stored dismissals: %s",
        async (raw) => {
            localStorage.setItem(KEY, raw);
            renderWithApp(<Harness />);
            expect(
                await screen.findByRole("button", {
                    name: "Dismiss inactivity alert for Friendly 1",
                }),
            ).toBeInTheDocument();
        },
    );

    it("keeps a dismissal usable in the mounted session if storage writes fail", async () => {
        const user = userEvent.setup();
        renderWithApp(<Harness />);
        const dismiss = await screen.findByRole("button", {
            name: "Dismiss inactivity alert for Friendly 1",
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage unavailable");
        });
        await user.click(dismiss);
        expect(
            screen.queryByRole("button", {
                name: "Dismiss inactivity alert for Friendly 1",
            }),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: "Restore dismissed alerts" }),
        );
        expect(
            screen.getByRole("button", {
                name: "Dismiss inactivity alert for Friendly 1",
            }),
        ).toBeInTheDocument();
    });
});
