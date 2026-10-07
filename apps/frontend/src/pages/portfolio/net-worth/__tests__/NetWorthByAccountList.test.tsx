// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { NetWorthByAccountList } from "../NetWorthByAccountList";

describe("NetWorthByAccountList", () => {
    it("formats an absolute below-headline difference as localized money", async () => {
        renderWithApp(
            <NetWorthByAccountList
                rows={[
                    {
                        key: "cash",
                        accountId: 1,
                        label: "Cash",
                        type: "checking",
                        cash: 50,
                        holdings: 0,
                        total: 50,
                    },
                ]}
                currency="EUR"
                headline={100}
            />,
        );
        const message = await screen.findByText(/below net worth by/i);
        expect(message).toHaveTextContent(/50,00/);
        expect(message).not.toHaveTextContent(/-50\.00/);
        expect(screen.getByText(/these totals do not currently match/i)).toBeVisible();
        expect(screen.getByText("Checking")).toBeInTheDocument();
    });

    it("does not suggest investigating a matching breakdown", async () => {
        renderWithApp(
            <NetWorthByAccountList rows={[]} currency="EUR" headline={0} />,
        );
        expect(await screen.findByText(/matches net worth/i)).toBeInTheDocument();
        expect(
            screen.queryByText(/these totals do not currently match/i),
        ).not.toBeInTheDocument();
    });

    it("offers to assign unassigned holdings on the portfolio page", async () => {
        renderWithApp(
            <NetWorthByAccountList
                rows={[
                    {
                        key: "unassigned",
                        accountId: null,
                        label: "Unassigned",
                        cash: 0,
                        holdings: 50,
                        total: 50,
                    },
                ]}
                currency="EUR"
                headline={50}
            />,
        );
        expect(
            await screen.findByRole("link", { name: "Assign to an account" }),
        ).toHaveAttribute("href", "/portfolio");
    });
});
