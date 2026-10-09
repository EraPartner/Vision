// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen } from "@testing-library/react";
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
        getRowLabel,
    }: {
        columns: RenderedColumn[];
        data: TableTransaction[];
        getRowLabel: (row: TableTransaction) => string;
    }) => (
        <div>
            {columns.map((column) => (
                <div key={column.key} data-column={column.key}>
                    <span>{column.header}</span>
                    {data.map((row) => (
                        <div
                            key={`${column.key}-${row.id}`}
                            data-row-label={getRowLabel(row)}
                        >
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
        let resize: ResizeObserverCallback | undefined;
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback: ResizeObserverCallback) {
                    resize = callback;
                }
                observe() {}
                disconnect() {}
            },
        );
        const user = userEvent.setup();
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
                onSelectRow={vi.fn()}
                selectedRowId={null}
                isColumnVisible={() => true}
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
        const selectBoxes = screen.getAllByRole("checkbox", {
            name: /^Select transaction: .*Broker/,
        });
        expect(selectBoxes).toHaveLength(2);
        expect(selectBoxes[0].getAttribute("aria-label")).not.toEqual(
            selectBoxes[1].getAttribute("aria-label"),
        );
        await user.tab();
        expect(
            screen.getAllByRole("button", {
                name: /^Included: .*Broker/,
                pressed: true,
            }),
        ).toHaveLength(2);
        expect(document.body.textContent).toContain("35");
        expect(document.body.textContent).toContain("110");
        expect(document.querySelector('[data-column="date"]')).not.toBeNull();
        act(() =>
            resize?.(
                [{ contentRect: { width: 560 } } as ResizeObserverEntry],
                {} as ResizeObserver,
            ),
        );
        expect(document.querySelector('[data-column="date"]')).toBeNull();
        expect(document.querySelector('[data-column="bank"]')).toBeNull();
        expect(
            document.querySelector('[data-column="compactSummary"]'),
        ).not.toBeNull();
        expect(screen.getByText("USD row")).toBeInTheDocument();
        expect(screen.getByText("EUR row")).toBeInTheDocument();
        expect(document.querySelector('[data-column="amount"]')).not.toBeNull();
        expect(screen.getByText("Running balance")).toBeInTheDocument();
        act(() =>
            resize?.(
                [{ contentRect: { width: 1200 } } as ResizeObserverEntry],
                {} as ResizeObserver,
            ),
        );
        expect(document.querySelector('[data-column="date"]')).not.toBeNull();
        vi.unstubAllGlobals();
    });
});
