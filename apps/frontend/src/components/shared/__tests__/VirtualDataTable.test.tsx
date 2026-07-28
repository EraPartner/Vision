// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { useState } from "react";
import { VirtualDataTable, SERVER_SEARCH_MIN_LENGTH } from "@/components/shared/VirtualDataTable";
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import type { Column } from "@/types/dataTable";
import { SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";

// Provide synchronous translations so tests don't depend on async locale loading.
vi.mock("@/contexts/LanguageContext", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/contexts/LanguageContext")>();
    const { default: enDict } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string, vars?: Record<string, string | number>) => {
                let str = enDict[key] ?? key;
                if (vars) {
                    for (const [k, v] of Object.entries(vars)) {
                        str = str.replaceAll(`{${k}}`, String(v));
                    }
                }
                return str;
            },
        }),
    };
});

// Render all items regardless of DOM layout — no real scroll container needed in tests.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        getVirtualItems: () =>
            Array.from({ length: count }, (_, i) => ({
                key: i,
                index: i,
                start: i * estimateSize(),
                size: estimateSize(),
            })),
        getTotalSize: () => count * estimateSize(),
        measureElement: vi.fn(),
        scrollToIndex: vi.fn(),
    }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type TestRow = { id: number; name: string; value: number };

const COLUMNS: Column<TestRow>[] = [
    { key: "id", header: "ID" },
    { key: "name", header: "Name" },
    { key: "value", header: "Value" },
];

const EDITABLE_COLUMNS: Column<TestRow>[] = [
    { key: "id", header: "ID" },
    { key: "name", header: "Name", editable: true, type: "text" },
    { key: "value", header: "Value", editable: true, type: "number" },
];

const DATA: TestRow[] = [
    { id: 1, name: "Alpha", value: 100 },
    { id: 2, name: "Beta", value: 200 },
    { id: 3, name: "Gamma", value: 300 },
];

function renderTable(props: Partial<Parameters<typeof VirtualDataTable<TestRow>>[0]> = {}) {
    return renderWithApp(
        <VirtualDataTable<TestRow>
            title="My Table"
            columns={COLUMNS}
            data={DATA}
            {...props}
        />,
    );
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe("VirtualDataTable — rendering", () => {
    it("renders title", () => {
        renderTable();
        expect(screen.getByText("My Table")).toBeInTheDocument();
    });

    it("renders subtitle when provided", () => {
        renderTable({ subtitle: "3 items" });
        expect(screen.getByText("3 items")).toBeInTheDocument();
    });

    it("renders column headers", () => {
        renderTable();
        // Column headers appear in the sticky header row
        const headers = screen.getAllByText("Name");
        expect(headers.length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("Value").length).toBeGreaterThanOrEqual(1);
    });

    it("renders row data", () => {
        renderTable();
        expect(screen.getByText("Alpha")).toBeInTheDocument();
        expect(screen.getByText("Beta")).toBeInTheDocument();
        expect(screen.getByText("Gamma")).toBeInTheDocument();
    });

    it("shows default empty message when data is empty", () => {
        renderTable({ data: [] });
        expect(screen.getByText("No data to display")).toBeInTheDocument();
    });

    it("shows custom empty message when provided", () => {
        renderTable({ data: [], emptyMessage: "Nothing here yet" });
        expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    });

    it("renders actions slot", () => {
        renderTable({ actions: <button>Add row</button> });
        expect(screen.getByRole("button", { name: "Add row" })).toBeInTheDocument();
    });

    it("footer shows loaded count", () => {
        renderTable();
        expect(screen.getByText(/3 of 3 loaded/)).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
// Local search
// ---------------------------------------------------------------------------

describe("VirtualDataTable — local search", () => {
    it("search input has correct placeholder in local-search mode", () => {
        renderTable();
        expect(
            screen.getByPlaceholderText("Search across all columns..."),
        ).toBeInTheDocument();
    });

    it("filtering rows updates the footer count", async () => {
        const user = userEvent.setup();
        renderTable();
        await user.type(
            screen.getByPlaceholderText("Search across all columns..."),
            "Alpha",
        );
        await waitFor(() =>
            expect(screen.getByText(/1 of 3 shown \(filtered\)/)).toBeInTheDocument(),
        );
    });

    it("shows no-results message when search matches nothing", async () => {
        const user = userEvent.setup();
        renderTable();
        await user.type(
            screen.getByPlaceholderText("Search across all columns..."),
            "ZZZNOMATCH",
        );
        await waitFor(() =>
            expect(
                screen.getByText("No results match your filters."),
            ).toBeInTheDocument(),
        );
    });

    it("clear search button restores all rows", async () => {
        const user = userEvent.setup();
        renderTable();
        const input = screen.getByPlaceholderText("Search across all columns...");
        await user.type(input, "Alpha");
        await waitFor(() => expect(screen.getByText(/1 of 3/)).toBeInTheDocument());

        // The X button appears next to the input when search is non-empty
        const clearBtn = input.parentElement!.querySelector("button")!;
        await user.click(clearBtn);
        await waitFor(() => expect(screen.getByText(/3 of 3 loaded/)).toBeInTheDocument());
    });
});

// ---------------------------------------------------------------------------
// Server-side search
// ---------------------------------------------------------------------------

describe("VirtualDataTable — server-side search", () => {
    afterEach(() => vi.useRealTimers());

    it("uses 'Search database...' placeholder when server search provided", () => {
        renderTable({ serverMode: { search: { onChange: vi.fn() } } });
        expect(screen.getByPlaceholderText("Search database...")).toBeInTheDocument();
    });

    it(`calls onSearchChange after ${SEARCH_DEBOUNCE_MS} ms debounce`, async () => {
        vi.useFakeTimers();
        const onSearchChange = vi.fn();
        renderTable({ serverMode: { search: { onChange: onSearchChange } } });

        fireEvent.change(
            screen.getByPlaceholderText("Search database..."),
            { target: { value: "test query" } },
        );
        expect(onSearchChange).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        expect(onSearchChange).toHaveBeenCalledWith("test query");
    });

    it(`does not fire onSearchChange before ${SEARCH_DEBOUNCE_MS} ms`, async () => {
        vi.useFakeTimers();
        const onSearchChange = vi.fn();
        renderTable({ serverMode: { search: { onChange: onSearchChange } } });

        fireEvent.change(
            screen.getByPlaceholderText("Search database..."),
            { target: { value: "partial" } },
        );
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
        expect(onSearchChange).not.toHaveBeenCalled();
    });

    it(`forwards "" (unfiltered) for input shorter than ${SERVER_SEARCH_MIN_LENGTH} characters and never issues a filtered search`, async () => {
        vi.useFakeTimers();
        const onSearchChange = vi.fn();
        renderTable({ serverMode: { search: { onChange: onSearchChange } } });

        const input = screen.getByPlaceholderText("Search database...");
        fireEvent.change(input, { target: { value: "ab" } });
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(onSearchChange).toHaveBeenCalledWith("");
        expect(onSearchChange).not.toHaveBeenCalledWith("ab");
        // The input keeps the user's typed text — only the forwarded search resets.
        expect(input).toHaveValue("ab");
    });

    it("whitespace-padded input below the threshold counts as too short", async () => {
        vi.useFakeTimers();
        const onSearchChange = vi.fn();
        renderTable({ serverMode: { search: { onChange: onSearchChange } } });

        fireEvent.change(
            screen.getByPlaceholderText("Search database..."),
            { target: { value: "  ab  " } },
        );
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(onSearchChange).toHaveBeenCalledWith("");
        expect(onSearchChange).not.toHaveBeenCalledWith("ab");
    });

    it(`forwards the trimmed term once the input reaches ${SERVER_SEARCH_MIN_LENGTH} characters`, async () => {
        vi.useFakeTimers();
        const onSearchChange = vi.fn();
        renderTable({ serverMode: { search: { onChange: onSearchChange } } });

        fireEvent.change(
            screen.getByPlaceholderText("Search database..."),
            { target: { value: "  abc " } },
        );
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(onSearchChange).toHaveBeenCalledWith("abc");
    });

    it("resets the forwarded search to \"\" when a filtered query is shortened below the threshold, keeping the typed text", async () => {
        vi.useFakeTimers();
        // Controlled harness mirroring the real call sites (TransactionsPage /
        // RecipientsPage): the forwarded value loops back in as search.value.
        const onSearchChange = vi.fn();
        function Harness() {
            const [search, setSearch] = useState("");
            return (
                <VirtualDataTable<TestRow>
                    title="My Table"
                    columns={COLUMNS}
                    data={DATA}
                    serverMode={{
                        search: {
                            onChange: (q) => { onSearchChange(q); setSearch(q); },
                            value: search,
                        },
                    }}
                />
            );
        }
        renderWithApp(<Harness />);

        const input = screen.getByPlaceholderText("Search database...");
        fireEvent.change(input, { target: { value: "abcd" } });
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        expect(onSearchChange).toHaveBeenLastCalledWith("abcd");

        fireEvent.change(input, { target: { value: "ab" } });
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        // Below the threshold: unfiltered (never stale "abcd" results) …
        expect(onSearchChange).toHaveBeenLastCalledWith("");
        // … while the echoed-back "" must not wipe what the user typed.
        expect(input).toHaveValue("ab");
    });
});

// ---------------------------------------------------------------------------
// Server-side sort
// ---------------------------------------------------------------------------

describe("VirtualDataTable — server-side sort", () => {
    it("first click calls onSortChange with asc", async () => {
        const user = userEvent.setup();
        const onSortChange = vi.fn();
        renderTable({ serverMode: { sort: { onChange: onSortChange, key: null, dir: null } } });
        await user.click(screen.getAllByRole("button", { name: /Name/ })[0]);
        expect(onSortChange).toHaveBeenCalledWith("name", "asc");
    });

    it("second click on same column calls onSortChange with desc", async () => {
        const user = userEvent.setup();
        const onSortChange = vi.fn();
        renderTable({ serverMode: { sort: { onChange: onSortChange, key: "name", dir: "asc" } } });
        await user.click(screen.getAllByRole("button", { name: /Name/ })[0]);
        expect(onSortChange).toHaveBeenCalledWith("name", "desc");
    });

    it("third click on same column calls onSortChange to clear sort", async () => {
        const user = userEvent.setup();
        const onSortChange = vi.fn();
        renderTable({ serverMode: { sort: { onChange: onSortChange, key: "name", dir: "desc" } } });
        await user.click(screen.getAllByRole("button", { name: /Name/ })[0]);
        expect(onSortChange).toHaveBeenCalledWith(null, null);
    });
});

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

describe("VirtualDataTable — inline editing", () => {
    it("double-clicking a row enters edit mode (inputs appear)", async () => {
        const user = userEvent.setup();
        renderTable({ columns: EDITABLE_COLUMNS });
        await user.dblClick(screen.getByText("Alpha"));
        // The name cell should now show an input instead of plain text
        const inputs = screen.getAllByRole("textbox");
        expect(inputs.length).toBeGreaterThan(0);
    });

    it("cancel button restores view mode", async () => {
        const user = userEvent.setup();
        renderTable({ columns: EDITABLE_COLUMNS });
        await user.dblClick(screen.getByText("Alpha"));
        // Find cancel button (X icon in the edit action cell)
        const actionButtons = screen.getAllByRole("button");
        const cancelBtn = actionButtons.find(
            (b) => b.querySelector("svg") && b.className.includes("destructive"),
        );
        if (cancelBtn) await user.click(cancelBtn);
        // After cancel, plain text "Alpha" should be visible again
        await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
        // 1 textbox remains: the always-visible search input (not the row edit input)
        expect(screen.queryAllByRole("textbox")).toHaveLength(1);
    });

    it("Escape key cancels editing", async () => {
        const user = userEvent.setup();
        renderTable({ columns: EDITABLE_COLUMNS });
        await user.dblClick(screen.getByText("Alpha"));
        // Focus the name edit input (index 1; index 0 is the search input) before pressing Escape
        const nameInput = screen.getAllByRole("textbox")[1];
        await user.click(nameInput);
        await user.keyboard("{Escape}");
        // 1 textbox remains: the always-visible search input
        await waitFor(() => expect(screen.queryAllByRole("textbox")).toHaveLength(1));
    });

    it("saves edits and calls onRowUpdate", async () => {
        const user = userEvent.setup();
        const onRowUpdate = vi.fn();
        renderTable({ columns: EDITABLE_COLUMNS, onRowUpdate });

        await user.dblClick(screen.getByText("Alpha"));
        // index 0 = search input; index 1 = name column edit input
        const nameInput = screen.getAllByRole("textbox")[1];
        await user.clear(nameInput);
        await user.type(nameInput, "Updated");
        await user.keyboard("{Enter}");

        await waitFor(() =>
            expect(onRowUpdate).toHaveBeenCalledWith(
                0,
                expect.objectContaining({ name: "Updated" }),
            ),
        );
    });

    it("keeps the original number when the field is cleared (no silent 0.00 save)", async () => {
        const user = userEvent.setup();
        const onRowUpdate = vi.fn();
        renderTable({ columns: EDITABLE_COLUMNS, onRowUpdate });

        await user.dblClick(screen.getByText("Alpha"));
        const valueInput = screen.getByRole("spinbutton");
        await user.clear(valueInput);
        await user.keyboard("{Enter}");

        // Row 0's value is 100 — a cleared field must not become 0.
        await waitFor(() =>
            expect(onRowUpdate).toHaveBeenCalledWith(
                0,
                expect.objectContaining({ value: 100 }),
            ),
        );
    });

    it("parses an edited number value at save time", async () => {
        const user = userEvent.setup();
        const onRowUpdate = vi.fn();
        renderTable({ columns: EDITABLE_COLUMNS, onRowUpdate });

        await user.dblClick(screen.getByText("Alpha"));
        const valueInput = screen.getByRole("spinbutton");
        await user.clear(valueInput);
        await user.type(valueInput, "12.5");
        await user.keyboard("{Enter}");

        await waitFor(() =>
            expect(onRowUpdate).toHaveBeenCalledWith(
                0,
                expect.objectContaining({ value: 12.5 }),
            ),
        );
    });
});

// ---------------------------------------------------------------------------
// Keyboard navigation & quick look (V7/V6)
// ---------------------------------------------------------------------------

function getRow(cellText: string): HTMLElement {
    return screen.getByText(cellText).closest('[role="row"]') as HTMLElement;
}

describe("VirtualDataTable — keyboard navigation", () => {
    it("Enter on a focused row calls onRowOpen with row and index", () => {
        const onRowOpen = vi.fn();
        renderTable({ onRowOpen });
        const row = getRow("Alpha");
        row.focus();
        fireEvent.keyDown(row, { key: "Enter" });
        expect(onRowOpen).toHaveBeenCalledWith(DATA[0], 0);
    });

    it("Space on a focused row calls onRowQuickLook", () => {
        const onRowQuickLook = vi.fn();
        renderTable({ onRowQuickLook });
        const row = getRow("Beta");
        row.focus();
        fireEvent.keyDown(row, { key: " " });
        expect(onRowQuickLook).toHaveBeenCalledWith(DATA[1], 1);
    });

    it("Enter and Space fall back to onRowDoubleClick when no dedicated handlers", () => {
        const onRowDoubleClick = vi.fn();
        renderTable({ onRowDoubleClick });
        const row = getRow("Alpha");
        row.focus();
        fireEvent.keyDown(row, { key: "Enter" });
        fireEvent.keyDown(row, { key: " " });
        expect(onRowDoubleClick).toHaveBeenCalledTimes(2);
    });

    it("ArrowDown / ArrowUp move focus between rows", async () => {
        renderTable({ onRowOpen: vi.fn() });
        const first = getRow("Alpha");
        const second = getRow("Beta");
        first.focus();
        fireEvent.keyDown(first, { key: "ArrowDown" });
        await waitFor(() => expect(second).toHaveFocus());
        fireEvent.keyDown(second, { key: "ArrowUp" });
        await waitFor(() => expect(first).toHaveFocus());
    });

    it("ArrowUp on the first row keeps focus clamped to it", async () => {
        renderTable({ onRowOpen: vi.fn() });
        const first = getRow("Alpha");
        first.focus();
        fireEvent.keyDown(first, { key: "ArrowUp" });
        await waitFor(() => expect(first).toHaveFocus());
    });

    it("rows are not focusable when no row handlers are provided", () => {
        renderTable();
        expect(getRow("Alpha")).not.toHaveAttribute("tabindex");
    });
});

// ---------------------------------------------------------------------------
// Row context menu (V5)
// ---------------------------------------------------------------------------

describe("VirtualDataTable — row context menu", () => {
    it("right-click opens the menu and onSelect receives the row", async () => {
        const onAction = vi.fn();
        renderTable({
            rowContextMenu: (row) => (
                <ContextMenuContent>
                    <ContextMenuItem onSelect={() => onAction(row.id)}>Row action</ContextMenuItem>
                </ContextMenuContent>
            ),
        });
        fireEvent.contextMenu(getRow("Gamma"));
        const item = await screen.findByText("Row action");
        fireEvent.click(item);
        await waitFor(() => expect(onAction).toHaveBeenCalledWith(3));
    });

    it("startEditing helper begins the inline edit for that row", async () => {
        renderTable({
            columns: EDITABLE_COLUMNS,
            rowContextMenu: (_row, _index, helpers) => (
                <ContextMenuContent>
                    <ContextMenuItem onSelect={helpers.startEditing}>Edit row</ContextMenuItem>
                </ContextMenuContent>
            ),
        });
        fireEvent.contextMenu(getRow("Alpha"));
        fireEvent.click(await screen.findByText("Edit row"));
        // Row edit inputs appear in addition to the always-present search input.
        await waitFor(() => expect(screen.getAllByRole("textbox").length).toBeGreaterThan(1));
    });
});

// ---------------------------------------------------------------------------
// Clear all
// ---------------------------------------------------------------------------

describe("VirtualDataTable — clear all", () => {
    it("clear-all button appears after search and clears state", async () => {
        const user = userEvent.setup();
        renderTable();
        await user.type(
            screen.getByPlaceholderText("Search across all columns..."),
            "X",
        );
        const clearAll = await screen.findByRole("button", { name: /Clear all/i });
        expect(clearAll).toBeInTheDocument();

        await user.click(clearAll);
        await waitFor(() =>
            expect(screen.queryByRole("button", { name: /Clear all/i })).not.toBeInTheDocument(),
        );
    });
});
