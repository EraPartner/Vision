// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { NetWorthByAccountTable } from "../NetWorthByAccountTable";

describe("NetWorthByAccountTable", () => {
    it("formats an absolute below-headline difference as localized money", () => {
        renderWithApp(
            <NetWorthByAccountTable
                rows={[
                    {
                        key: "cash",
                        accountId: 1,
                        label: "Cash",
                        cash: 50,
                        holdings: 0,
                        total: 50,
                    },
                ]}
                currency="EUR"
                headline={100}
                t={(key) =>
                    key === "networth.byAccount.below"
                        ? "Below net worth by"
                        : key
                }
            />,
        );
        const message = screen.getByText(/below net worth by/i);
        expect(message.parentElement).toHaveTextContent(/50,00/);
        expect(message.parentElement).not.toHaveTextContent(/-50\.00/);
    });
});
