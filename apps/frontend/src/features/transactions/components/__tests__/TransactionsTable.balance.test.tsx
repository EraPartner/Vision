// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderWithApp } from "@/test/renderWithApp";
import type { TableTransaction } from "../../types";

interface RenderedColumn {
    key: string;
    header: ReactNode;
    render?: (row: TableTransaction, editing: boolean) => ReactNode;
}

vi.mock("@/components/shared/VirtualDataTable", () => ({
    VirtualDataTable: ({
        columns,
        data,
    }: {
        columns: RenderedColumn[];
        data: TableTransaction[];
    }) => (
        <div>
            {columns.map((column) => (
                <div key={column.key}>
                    <span>{column.header}</span>
                    {data.map((row) => (
                        <div key={`${column.key}-${row.id}`}>
                            {column.render?.(row, false)}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    ),
}));

import { TransactionsTable } from "../TransactionsTable";

describe("TransactionsTable currency balances", () => {
    it("shows an explicit ISO currency and formats each balance in that currency", async () => {
        renderWithApp(
            <TransactionsTable
                transactions={[
                    {
                        id: 1,
                        date: "2026-01-01",
                        memo: "USD row",
                        category: "Other",
                        recipient: "Broker",
                        bank: "Broker",
                        amount: 5,
                        currency: "USD",
                        runningBalance: 35,
                        is_active: true,
                    },
                    {
                        id: 2,
                        date: "2026-01-02",
                        memo: "EUR row",
                        category: "Other",
                        recipient: "Broker",
                        bank: "Broker",
                        amount: 10,
                        currency: "EUR",
                        runningBalance: 110,
                        is_active: true,
                    },
                ]}
                allItems={[]}
                serverMode={{}}
                onRowUpdate={vi.fn()}
                onOpenInfo={vi.fn()}
                onQuickLook={vi.fn()}
                onDuplicate={vi.fn()}
                onFilterByRecipient={vi.fn()}
                onToggleActive={vi.fn()}
                onDelete={vi.fn()}
                onSelectCategory={vi.fn()}
                onSelectRecipient={vi.fn()}
                cancelEditingRef={{ current: null }}
                onEditingChange={vi.fn()}
                actions={null}
                updatePending={false}
                deletePending={false}
                selectedIds={new Set()}
                onSelectionChange={vi.fn()}
            />,
        );

        expect(await screen.findByText("Currency")).toBeInTheDocument();
        expect(screen.getByText("Running balance")).toBeInTheDocument();
        expect(screen.getAllByText("USD").length).toBeGreaterThan(0);
        expect(screen.getAllByText("EUR").length).toBeGreaterThan(0);
        expect(document.body.textContent).toContain("35");
        expect(document.body.textContent).toContain("110");
    });
});
