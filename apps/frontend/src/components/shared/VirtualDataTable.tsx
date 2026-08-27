import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CardSheen } from "@/components/shared/CardSheen";
import { parseDecimal } from "@/lib/decimal";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    ArrowDown, ArrowUp, ArrowUpDown, Check, Filter, Loader2,
    Pencil, Search, X,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import { ColumnFilter } from "@/components/shared/ColumnFilter";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import type { Column } from "@/types/dataTable";
import { cn } from "@/lib/utils";

export type { Column };

export type SortDirection = "asc" | "desc" | null;

/**
 * Minimum trimmed length before a server-mode search is forwarded to
 * `search.onChange`. Below this the table forwards "" so the list shows
 * UNFILTERED results (never stale ones) while the input keeps the user's
 * text. Companion of the server-side `MIN_SEARCH_LENGTH`
 * (apps/node-backend/src/lib/filterBuilder.js): the backend ignores
 * sub-length terms anyway, so forwarding them only refetches for nothing.
 */
export const SERVER_SEARCH_MIN_LENGTH = 3;
const MAX_COLUMN_WIDTH = 2000;

/** The query actually forwarded to the server for a given raw input value. */
function gateServerSearch(value: string): string {
    const trimmed = value.trim();
    return trimmed.length >= SERVER_SEARCH_MIN_LENGTH ? trimmed : "";
}

/**
 * Server-driven data operations, grouped by concern. Presence of a group turns
 * that concern over to the server; omit the whole object for a fully local table.
 *
 * - `sort`: clicking a column header calls `sort.onChange` instead of sorting
 *   locally, so the full dataset (not just the loaded page) is sorted by the
 *   server. `key`/`dir` are the controlled sort state.
 * - `search`: the search box debounces into `search.onChange` instead of
 *   filtering loaded rows locally.
 * - `pagination`: infinite scroll near the bottom calls `pagination.onLoadMore`.
 */
export interface VirtualTableServerMode {
    sort?: {
        /** Called with the next key/direction when a column header is clicked. */
        onChange: (key: string | null, dir: SortDirection) => void;
        /** Controlled sort key */
        key?: string | null;
        /** Controlled sort direction */
        dir?: SortDirection;
    };
    search?: {
        /** Server-side search callback (debounced) */
        onChange: (query: string) => void;
        /** Controlled search value */
        value?: string;
        /**
         * Optional filter-suggestion dropdown rendered under the search input while
         * it is focused. Receives the live query and a `close()` to dismiss the
         * dropdown (e.g. after applying a filter). The table only provides the
         * anchor + open state; the suggestion content is owned by the caller.
         */
        suggestions?: (ctx: { query: string; close: () => void }) => React.ReactNode;
    };
    pagination?: {
        /** Total items available on server */
        totalItems?: number;
        /** Whether more data is currently being fetched */
        isFetchingMore?: boolean;
        /** Called when the user scrolls near the bottom and more data should be loaded */
        onLoadMore?: () => void;
        /** Whether there are more items to load */
        hasMore?: boolean;
        /** Number of rows from the end before triggering onLoadMore. Defaults to 15 */
        loadMoreOffset?: number;
    };
}

interface VirtualDataTableProps<T> {
    title?: string;
    subtitle?: string;
    columns: Column<T>[];
    data: T[];
    emptyMessage?: React.ReactNode;
    actions?: React.ReactNode;
    onRowUpdate?: (index: number, updatedRow: T) => void;
    /** Called when a row is double-clicked */
    onRowDoubleClick?: (row: T, index: number) => void;
    /** Called on Enter on a focused row. Falls back to onRowDoubleClick. */
    onRowOpen?: (row: T, index: number) => void;
    /** Called on Space on a focused row (Quick Look). Falls back to onRowDoubleClick. */
    onRowQuickLook?: (row: T, index: number) => void;
    /**
     * Right-click menu for rows: return a <ContextMenuContent> (it is rendered
     * inside a per-row Radix ContextMenu root). `helpers.startEditing` begins
     * the table's inline edit for that row.
     */
    rowContextMenu?: (row: T, index: number, helpers: { startEditing: () => void }) => React.ReactNode;
    /** Server-side sort / search / pagination. Omit for a fully local table. */
    serverMode?: VirtualTableServerMode;
    /** Height of the virtual scroll container. Defaults to 600 */
    maxHeight?: number;
    /** Estimated row height for virtualizer */
    rowHeight?: number;
    /** Optional ref callback to get the cancelEditing function for external use */
    cancelEditingRef?: React.MutableRefObject<(() => void) | null>;
    /** Optional callback to notify when editing state changes (true = editing started, false = editing ended) */
    onEditingChange?: (editing: boolean) => void;
}

interface IndexedRow<T> {
    row: T;
    sourceIndex: number;
}

function getSortValue(val: unknown): string | number {
    if (val == null) return "";
    if (typeof val === "number") return val;
    if (typeof val === "boolean") return val ? 1 : 0;
    return String(val).toLowerCase();
}

function getRowKey<T extends Record<string, unknown>>(row: T, fallbackIndex: number): string | number {
    const candidate = row.id;
    return (typeof candidate === "string" || typeof candidate === "number") ? candidate : fallbackIndex;
}

interface VirtualizedTableRowProps<T extends Record<string, unknown>> {
    row: T;
    sourceIndex: number;
    virtualIndex: number;
    virtualStart: number;
    isFirstVisible: boolean;
    isEditing: boolean;
    isCoarsePointer: boolean;
    columns: Column<T>[];
    columnWidths: Record<string, number>;
    editValues?: Record<string, unknown>;
    hasEditableColumns: boolean;
    measureElement: React.Ref<HTMLDivElement>;
    onRowDoubleClick?: (row: T, index: number) => void;
    onRowOpen?: (row: T, index: number) => void;
    onRowQuickLook?: (row: T, index: number) => void;
    rowContextMenu?: VirtualDataTableProps<T>["rowContextMenu"];
    startEditing: (sourceIndex: number, row: T) => void;
    saveEditing?: (sourceIndex: number, row: T) => void;
    cancelEditing: () => void;
    setEditValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    focusRowByIndex?: (index: number) => void;
    saveLabel: string;
    cancelLabel: string;
    editLabel: string;
}

function VirtualizedTableRow<T extends Record<string, unknown>>({
    row,
    sourceIndex,
    virtualIndex,
    virtualStart,
    isFirstVisible,
    isEditing,
    isCoarsePointer,
    columns,
    columnWidths,
    editValues,
    hasEditableColumns,
    measureElement,
    onRowDoubleClick,
    onRowOpen,
    onRowQuickLook,
    rowContextMenu,
    startEditing,
    saveEditing,
    cancelEditing,
    setEditValues,
    focusRowByIndex,
    saveLabel,
    cancelLabel,
    editLabel,
}: VirtualizedTableRowProps<T>) {
    const rowsInteractive = !!(onRowDoubleClick || onRowOpen || onRowQuickLook);
    const rowEl = (
        <div
            data-index={virtualIndex}
            ref={measureElement}
            role="row"
            aria-rowindex={virtualIndex + 2}
            tabIndex={rowsInteractive ? (isFirstVisible ? 0 : -1) : undefined}
            className={cn(
                "flex items-center border-b border-border transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2",
                isEditing && "bg-primary/5",
                onRowDoubleClick && "cursor-pointer",
                rowsInteractive && "touch-manipulation active:bg-muted",
            )}
            style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualStart}px)`,
            }}
            onDoubleClick={() => {
                if (onRowDoubleClick) {
                    onRowDoubleClick(row, sourceIndex);
                } else if (hasEditableColumns && !isEditing) {
                    startEditing(sourceIndex, row);
                }
            }}
            onClick={isCoarsePointer && rowsInteractive ? (event) => {
                if (isEditing) return;
                const openAction = onRowOpen ?? onRowDoubleClick;
                if (!openAction) return;
                const target = event.target as HTMLElement;
                if (target.closest('button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [role="checkbox"], [contenteditable="true"]')) return;
                openAction(row, sourceIndex);
            } : undefined}
            onKeyDown={rowsInteractive ? (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    focusRowByIndex?.(virtualIndex + (event.key === "ArrowDown" ? 1 : -1));
                } else if (event.key === "Enter") {
                    event.preventDefault();
                    (onRowOpen ?? onRowDoubleClick)?.(row, sourceIndex);
                } else if (event.key === " ") {
                    event.preventDefault();
                    (onRowQuickLook ?? onRowDoubleClick)?.(row, sourceIndex);
                }
            } : undefined}
        >
            {columns.map((col) => {
                const width = columnWidths[col.key];
                return (
                    <div
                        key={col.key}
                        role="cell"
                        className={cn("px-4 py-2 text-sm flex-1 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]", col.className || "")}
                        style={width ? { width: `${width}px`, flex: "none" } : undefined}
                    >
                        {isEditing && col.editable ? (
                            col.type === "date" ? (
                                <DatePicker
                                    value={editValues?.[col.key] ? parseLocalDateFromYmd(String(editValues[col.key])) : undefined}
                                    onChange={(date) => setEditValues((prev) => ({ ...prev, [col.key]: date ? toYmd(date) : "" }))}
                                    buttonClassName="h-8 text-sm w-full"
                                />
                            ) : (
                                <Input
                                    type={col.type || "text"}
                                    value={String(editValues?.[col.key] ?? "")}
                                    onChange={(event) => setEditValues((prev) => ({ ...prev, [col.key]: event.target.value }))}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") { event.preventDefault(); saveEditing?.(sourceIndex, row); }
                                        else if (event.key === "Escape") { event.preventDefault(); cancelEditing(); }
                                    }}
                                    className="h-8 text-sm"
                                />
                            )
                        ) : col.render ? (
                            col.render(row, isEditing, sourceIndex)
                        ) : (
                            String(row[col.key] ?? "")
                        )}
                    </div>
                );
            })}
            {hasEditableColumns && (
                <div role="cell" className="px-1 py-2 text-right" style={{ width: isEditing ? "88px" : "40px", flex: "none" }}>
                    {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon" aria-label={saveLabel}
                                className="icon-touch-target text-accent hover:text-accent hover:bg-accent/10"
                                onClick={() => saveEditing?.(sourceIndex, row)}>
                                <Check className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={cancelLabel}
                                className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={cancelEditing}>
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    ) : (
                        <Button variant="ghost" size="icon" aria-label={editLabel}
                            className="icon-touch-target text-muted-foreground hover:text-primary hover:bg-primary/10"
                            onClick={() => startEditing(sourceIndex, row)}>
                            <Pencil className="h-4 w-4" />
                        </Button>
                    )}
                </div>
            )}
        </div>
    );

    if (!rowContextMenu) return rowEl;
    return (
        <ContextMenu modal={false}>
            <ContextMenuTrigger asChild>{rowEl}</ContextMenuTrigger>
            {rowContextMenu(row, sourceIndex, { startEditing: () => startEditing(sourceIndex, row) })}
        </ContextMenu>
    );
}

const MemoizedVirtualizedTableRow = memo(VirtualizedTableRow) as typeof VirtualizedTableRow;

export function VirtualDataTable<T extends Record<string, unknown>>({
    title,
    subtitle,
    columns,
    data,
    emptyMessage,
    actions,
    onRowUpdate,
    onRowDoubleClick,
    onRowOpen,
    onRowQuickLook,
    rowContextMenu,
    serverMode,
    maxHeight = 600,
    rowHeight = 44,
    cancelEditingRef,
    onEditingChange,
}: VirtualDataTableProps<T>) {
    // Ungroup the server-mode config once — all internal logic keys off these
    // leaf values (identical names/defaults to the former flat props), so a
    // fresh `serverMode` object identity per render costs nothing: hooks below
    // depend on the leaves, and the leaf callbacks are as stable as the caller
    // makes them.
    const onSortChange = serverMode?.sort?.onChange;
    const sortKeyProp = serverMode?.sort?.key;
    const sortDirProp = serverMode?.sort?.dir;
    const onSearchChange = serverMode?.search?.onChange;
    const searchValue = serverMode?.search?.value;
    const searchSuggestions = serverMode?.search?.suggestions;
    const totalItems = serverMode?.pagination?.totalItems;
    const isFetchingMore = serverMode?.pagination?.isFetchingMore ?? false;
    const onLoadMore = serverMode?.pagination?.onLoadMore;
    const hasMore = serverMode?.pagination?.hasMore ?? false;
    const loadMoreOffset = serverMode?.pagination?.loadMoreOffset ?? 15;

    const { t } = useLanguage();
    // Coarse pointers (touch) can't reliably double-click and iOS Safari never
    // fires `contextmenu` on long-press, so the mouse-only row actions are dead
    // on touch. Detect a coarse pointer once and enable single-tap "open".
    // Guarded for jsdom/SSR (no matchMedia) → false, keeping the desktop
    // double-click path unchanged in tests and on fine pointers.
    const isCoarsePointer = useMemo(
        () =>
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(pointer: coarse)").matches,
        [],
    );
    const isServerSort = !!onSortChange;
    const [editingRow, setEditingRow] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Record<string, unknown>>({});
    const isServerSearch = !!onSearchChange;
    const [localSearchQuery, setLocalSearchQuery] = useState(searchValue ?? "");
    const [searchFocused, setSearchFocused] = useState(false);
    const searchContainerRef = useRef<HTMLDivElement | null>(null);

    // Notify parent when editing state changes
    useEffect(() => {
        onEditingChange?.(editingRow !== null);
    }, [editingRow, onEditingChange]);

    const cancelEditing = useCallback(() => { setEditingRow(null); setEditValues({}); }, []);

    // Expose cancelEditing via ref
    useEffect(() => {
        if (cancelEditingRef) {
            cancelEditingRef.current = cancelEditing;
        }
    }, [cancelEditingRef, cancelEditing]);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isTypingRef = useRef(false);

    const clearPendingSearch = useCallback(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        isTypingRef.current = false;
    }, []);

    // Debounced server search - input updates immediately, but API call is debounced
    const handleSearchInput = useCallback((value: string) => {
        setLocalSearchQuery(value);
        if (isServerSearch) {
            isTypingRef.current = true;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
                onSearchChange!(gateServerSearch(value));
                debounceRef.current = null;
                isTypingRef.current = false;
            }, SEARCH_DEBOUNCE_MS);
        }
    }, [isServerSearch, onSearchChange]);

    const clearSearch = useCallback(() => {
        clearPendingSearch();
        setLocalSearchQuery("");
        if (isServerSearch) onSearchChange!("");
    }, [clearPendingSearch, isServerSearch, onSearchChange]);

    // Keep local search in sync with external searchValue changes (e.g., clear from outside)
    useEffect(() => {
        if (!isServerSearch) return;
        const externalQuery = searchValue ?? "";
        // `gateServerSearch(localSearchQuery)` is what this table last forwarded
        // for the current input. When the external value matches it, this is our
        // own (gated/trimmed) echo coming back — not an outside change — and
        // syncing would wipe the sub-threshold text the user is still typing.
        if (
            !isTypingRef.current &&
            externalQuery !== localSearchQuery &&
            externalQuery !== gateServerSearch(localSearchQuery)
        ) {
            setLocalSearchQuery(externalQuery);
        }
    }, [isServerSearch, searchValue, localSearchQuery]);

    useEffect(() => clearPendingSearch, [clearPendingSearch]);

    // Close the suggestion dropdown on outside-click or Escape. Only wired up
    // when suggestions are actually in use and currently open.
    useEffect(() => {
        if (!searchSuggestions || !searchFocused) return;
        const onPointerDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (searchContainerRef.current?.contains(target)) return;
            // A suggestion may open a portaled Radix popper (e.g. the date-range
            // calendar) that lives outside the search container's subtree — clicks
            // inside it must not dismiss the dropdown.
            if (target?.closest?.('[data-radix-popper-content-wrapper]')) return;
            setSearchFocused(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSearchFocused(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [searchSuggestions, searchFocused]);

    // In server-sort mode use controlled props; otherwise use local state
    const [localSortKey, setLocalSortKey] = useState<string | null>(null);
    const [localSortDir, setLocalSortDir] = useState<SortDirection>(null);
    const sortKey = isServerSort ? (sortKeyProp ?? null) : localSortKey;
    const sortDir = isServerSort ? (sortDirProp ?? null) : localSortDir;

    const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
    const [openFilter, setOpenFilter] = useState<string | null>(null);
    // Selection (and other per-render) changes rebuild the `columns` array with
    // fresh render/header closures while the column SET stays the same. Keying
    // expensive memos/effects on this value-stable key signature — and reading
    // the live array via a ref — avoids reprocessing the whole dataset on every
    // checkbox toggle (the array identity would otherwise invalidate them).
    const columnsRef = useRef(columns);
    columnsRef.current = columns;
    const columnKeySignature = columns.map((c) => c.key).join(",");

    const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
        const widths: Record<string, number> = {};
        columns.forEach((col) => {
            if (col.defaultWidth) widths[col.key] = col.defaultWidth;
        });
        return widths;
    });

    // Re-seed defaultWidth for any column not yet tracked — the useState
    // initialiser only runs once, so a locale change (new column objects) or
    // an added column would otherwise never pick up its default width.
    // Existing (possibly user-resized) widths are left untouched.
    useEffect(() => {
        setColumnWidths((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const col of columnsRef.current) {
                if (col.defaultWidth && next[col.key] === undefined) {
                    next[col.key] = col.defaultWidth;
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
        // Keyed on the column SET, not the array identity — a selection toggle
        // rebuilds `columns` with the same keys and must not re-run this.
    }, [columnKeySignature]);

    const resizingRef = useRef<{ key: string; pointerId: number; startX: number; startWidth: number } | null>(null);
    const resizeCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => resizeCleanupRef.current?.(), []);

    const handleResizeStart = useCallback((e: React.PointerEvent, colKey: string, currentWidth: number) => {
        e.preventDefault();
        resizeCleanupRef.current?.();
        resizingRef.current = { key: colKey, pointerId: e.pointerId, startX: e.clientX, startWidth: currentWidth };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        // Coalesce the per-pointermove state writes into one commit per animation
        // frame, so a fast drag re-renders the table at most once per frame.
        let rafId: number | null = null;
        let pendingWidth: number | null = null;
        const flush = () => {
            rafId = null;
            if (pendingWidth == null || !resizingRef.current) return;
            const key = resizingRef.current.key;
            const width = pendingWidth;
            setColumnWidths(prev => ({ ...prev, [key]: width }));
        };
        const handlePointerMove = (ev: PointerEvent) => {
            if (!resizingRef.current || ev.pointerId !== resizingRef.current.pointerId) return;
            const diff = ev.clientX - resizingRef.current.startX;
            const col = columns.find(c => c.key === resizingRef.current!.key);
            const minW = col?.minWidth || 60;
            pendingWidth = Math.min(MAX_COLUMN_WIDTH, Math.max(minW, resizingRef.current.startWidth + diff));
            if (rafId == null) rafId = requestAnimationFrame(flush);
        };
        const finishResize = (ev?: PointerEvent) => {
            if (ev && resizingRef.current && ev.pointerId !== resizingRef.current.pointerId) return;
            if (rafId != null) cancelAnimationFrame(rafId);
            flush();
            resizingRef.current = null;
            document.removeEventListener("pointermove", handlePointerMove);
            document.removeEventListener("pointerup", finishResize);
            document.removeEventListener("pointercancel", finishResize);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            resizeCleanupRef.current = null;
        };
        resizeCleanupRef.current = finishResize;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("pointermove", handlePointerMove);
        document.addEventListener("pointerup", finishResize);
        document.addEventListener("pointercancel", finishResize);
    }, [columns]);

    const handleResizeKeyDown = useCallback((e: React.KeyboardEvent, colKey: string, currentWidth: number) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const minWidth = columns.find((col) => col.key === colKey)?.minWidth || 60;
        const delta = e.key === "ArrowRight" ? 10 : -10;
        setColumnWidths((prev) => ({
            ...prev,
            [colKey]: Math.min(MAX_COLUMN_WIDTH, Math.max(minWidth, (prev[colKey] ?? currentWidth) + delta)),
        }));
    }, [columns]);

    const syncRenderedColumnWidth = useCallback((handle: HTMLDivElement, colKey: string, fallbackWidth: number) => {
        const measuredWidth = handle.parentElement?.getBoundingClientRect().width ?? 0;
        const minWidth = columns.find((col) => col.key === colKey)?.minWidth || 60;
        const width = Math.min(MAX_COLUMN_WIDTH, Math.max(minWidth, measuredWidth || fallbackWidth));
        setColumnWidths((prev) => prev[colKey] === width ? prev : { ...prev, [colKey]: width });
        return width;
    }, [columns]);

    const handleSort = (key: string) => {
        if (isServerSort) {
            // Cycle: null -> asc -> desc -> null; dispatch to parent
            let newDir: SortDirection;
            let newKey: string | null;
            if (sortKey === key) {
                if (sortDir === "asc") { newKey = key; newDir = "desc"; }
                else if (sortDir === "desc") { newKey = null; newDir = null; }
                else { newKey = key; newDir = "asc"; }
            } else {
                newKey = key; newDir = "asc";
            }
            onSortChange!(newKey, newDir);
        } else {
            if (localSortKey === key) {
                if (localSortDir === "asc") setLocalSortDir("desc");
                else if (localSortDir === "desc") { setLocalSortKey(null); setLocalSortDir(null); }
                else setLocalSortDir("asc");
            } else {
                setLocalSortKey(key);
                setLocalSortDir("asc");
            }
        }
    };

    const setColumnFilter = (key: string, value: string) => {
        setColumnFilters(prev => {
            const next = { ...prev };
            if (value) next[key] = value;
            else delete next[key];
            return next;
        });
    };

    const activeFilterCount = Object.keys(columnFilters).length;

    // Unique values are only needed for the filter popover that is currently
    // open — computing them for every column on every data change wastes a full
    // dataset scan during infinite scroll. Scoped to `openFilter` so the work
    // happens lazily when (and only when) a filter popover is opened.
    const openFilterUniqueValues = useMemo(() => {
        if (!openFilter) return [] as string[];
        const col = columns.find((c) => c.key === openFilter);
        if (!col || col.filterable === false || !col.header) return [];
        const vals = new Set<string>();
        data.forEach((row) => {
            const v = row[col.key];
            if (v != null && String(v).trim()) vals.add(String(v));
        });
        return Array.from(vals).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }, [data, columns, openFilter]);

    const deferredData = useDeferredValue(data);

    // In server-search mode the localSearchQuery filter branch below is skipped
    // entirely, so the query text must not re-run the O(n) pipeline on every
    // keystroke. Collapse it to a constant dep when the server does the search.
    const localSearchDep = isServerSearch ? "" : localSearchQuery;

    // Client-side filter/sort pipeline
    // NOTE: when onSortChange is provided (server-sort mode) the sort step is
    // skipped — the server already returns rows in the correct order.
    const processedRows = useMemo(() => {
        let result: IndexedRow<T>[] = deferredData.map((row, sourceIndex) => ({ row, sourceIndex }));

        for (const [key, filterVal] of Object.entries(columnFilters)) {
            const q = filterVal.toLowerCase();
            result = result.filter(({ row }) => {
                const v = row[key];
                return v != null && String(v).toLowerCase().includes(q);
            });
        }

        if (!isServerSearch && localSearchQuery.trim()) {
            const q = localSearchQuery.toLowerCase();
            result = result.filter(({ row }) =>
                columnsRef.current.some((col) => {
                    const val = row[col.key];
                    return val != null && String(val).toLowerCase().includes(q);
                })
            );
        }

        // Only apply client-side sort when NOT in server-sort mode
        if (!isServerSort && sortKey && sortDir) {
            result.sort((a, b) => {
                const va = getSortValue(a.row[sortKey]);
                const vb = getSortValue(b.row[sortKey]);
                let cmp: number;
                if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
                else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
                return sortDir === "desc" ? -cmp : cmp;
            });
        }

        return result;
        // columnKeySignature stands in for `columns` (read via columnsRef) so the
        // pipeline re-runs when the column SET changes but not on selection-driven
        // array rebuilds. eslint can't see that relationship.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deferredData, columnFilters, localSearchDep, isServerSearch, isServerSort, sortKey, sortDir, columnKeySignature]);

    // Virtualizer
    const parentRef = useRef<HTMLDivElement>(null);
    // Header lives in its own horizontal scroller separate from the body. On
    // narrow viewports the body can scroll horizontally while the header stays
    // put; drive the header's scrollLeft from the body's scroll to keep them in
    // sync. Only the body writes to the header (one-way) so there's no feedback
    // loop — the header has no onScroll handler writing back.
    const headerScrollRef = useRef<HTMLDivElement>(null);
    const loadRequestedForLengthRef = useRef<number | null>(null);
    const virtualizer = useVirtualizer({
        count: processedRows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => rowHeight,
        overscan: 10,
    });

    // Arrow-key row navigation: scroll the target row into the virtual window,
    // then focus it. The row may not be mounted on the first frame after
    // scrollToIndex, so retry across a few frames.
    const focusRowByIndex = useCallback((index: number) => {
        if (processedRows.length === 0) return;
        const clamped = Math.max(0, Math.min(index, processedRows.length - 1));
        virtualizer.scrollToIndex(clamped);
        const tryFocus = (attempt: number) => {
            const el = parentRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`);
            if (el) {
                el.focus({ preventScroll: true });
                return;
            }
            if (attempt < 5) requestAnimationFrame(() => tryFocus(attempt + 1));
        };
        requestAnimationFrame(() => tryFocus(0));
    }, [processedRows.length, virtualizer]);

    const maybeLoadMore = useCallback(() => {
        if (!onLoadMore || !hasMore || isFetchingMore) return;

        const parentEl = parentRef.current;
        if (!parentEl) return;

        const distanceToBottom = parentEl.scrollHeight - (parentEl.scrollTop + parentEl.clientHeight);
        const thresholdPx = Math.max(1, loadMoreOffset) * rowHeight;

        if (distanceToBottom > thresholdPx) return;

        if (loadRequestedForLengthRef.current === processedRows.length) return;
        loadRequestedForLengthRef.current = processedRows.length;
        onLoadMore();
    }, [onLoadMore, hasMore, isFetchingMore, loadMoreOffset, rowHeight, processedRows.length]);

    // No reset effect for loadRequestedForLengthRef: the equality guard in
    // maybeLoadMore already self-heals — once processedRows.length advances
    // past the requested length the comparison fails and exactly one new load
    // is allowed. A separate reset-to-null effect raced maybeLoadMore and
    // could re-fire onLoadMore for an already-requested page.

    // Infinite scroll: trigger load checks from actual scroll events only.
    useEffect(() => {
        const parentEl = parentRef.current;
        if (!parentEl || !onLoadMore) return;

        const handleScroll = () => {
            maybeLoadMore();
        };

        parentEl.addEventListener("scroll", handleScroll, { passive: true });
        return () => {
            parentEl.removeEventListener("scroll", handleScroll);
        };
    }, [onLoadMore, maybeLoadMore]);

    const startEditing = useCallback((sourceIndex: number, row: T) => {
        setEditingRow(sourceIndex);
        const values: Record<string, unknown> = {};
        columns.forEach((col) => {
            if (!col.editable) return;
            const val = row[col.key];
            values[col.key] = col.type === "date" && typeof val === "string" && val.includes("T")
                ? val.split("T")[0]
                : val;
        });
        setEditValues(values);
    }, [columns]);

    const saveEditing = useCallback((sourceIndex: number, row: T) => {
        if (onRowUpdate) {
            // Number columns keep the raw string while editing (so a decimal
            // separator can be typed) and are parsed here. A cleared number
            // field keeps the original value instead of saving a legit-looking
            // 0.00 (`parseDecimal("") → 0`).
            const values: Record<string, unknown> = { ...editValues };
            for (const col of columns) {
                if (!col.editable || col.type !== "number" || !(col.key in values)) continue;
                const raw = values[col.key];
                if (typeof raw === "string") {
                    if (raw.trim() === "") delete values[col.key];
                    else values[col.key] = parseDecimal(raw);
                }
            }
            const updatedRow = { ...row, ...values } as T;
            onRowUpdate(sourceIndex, updatedRow);
        }
        setEditingRow(null);
        setEditValues({});
    }, [columns, editValues, onRowUpdate]);

    const clearAllFilters = () => {
        clearPendingSearch();
        setColumnFilters({});
        setLocalSearchQuery("");
        if (isServerSearch) onSearchChange!("");
        if (isServerSort) {
            onSortChange!(null, null);
        } else {
            setLocalSortKey(null);
            setLocalSortDir(null);
        }
    };

    const hasEditableColumns = columns.some((c) => c.editable);
    const displayTotal = totalItems ?? data.length;

    const SortIcon = ({ colKey }: { colKey: string }) => {
        if (sortKey !== colKey) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
        if (sortDir === "asc") return <ArrowUp className="h-3 w-3 text-primary" />;
        return <ArrowDown className="h-3 w-3 text-primary" />;
    };

    return (
        <Card className="premium-frame relative overflow-hidden">
            <CardSheen />
            {(title || subtitle || actions) && (
                <CardHeader
                    className={cn(
                        "flex flex-row items-start space-y-0 pb-4",
                        title || subtitle ? "justify-between" : "justify-end",
                    )}
                >
                    {(title || subtitle) && (
                        <div>
                            {title && <CardTitle className="text-lg font-semibold">{title}</CardTitle>}
                            {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
                        </div>
                    )}
                    {actions && <div className="flex items-center gap-2">{actions}</div>}
                </CardHeader>
            )}

            {/* Search bar */}
            <div className="px-6 pb-3 flex items-center gap-3">
                <div className="relative flex-1" ref={searchContainerRef}>
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={isServerSearch ? t('table.searchDatabase') : t('table.searchAllColumns')}
                        value={localSearchQuery}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        onFocus={searchSuggestions ? () => setSearchFocused(true) : undefined}
                        className="pl-9 h-9"
                    />
                    {localSearchQuery && (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('aria.clearSearch')}
                            className="absolute right-1 top-1/2 -translate-y-1/2 icon-touch-target text-muted-foreground"
                            onClick={clearSearch}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                    {searchSuggestions && searchFocused && (
                        <div className="absolute left-0 right-0 top-full z-50 mt-1">
                            {searchSuggestions({
                                query: localSearchQuery,
                                close: () => setSearchFocused(false),
                            })}
                        </div>
                    )}
                </div>
                {(activeFilterCount > 0 || localSearchQuery || sortKey) && (
                    <Button
                        variant="ghost" size="sm"
                        onClick={clearAllFilters}
                        className="text-xs text-muted-foreground hover:text-destructive shrink-0 gap-1"
                    >
                        <X className="h-3 w-3" /> {t('table.clearAll')}
                        {activeFilterCount > 0 && (
                            <span className="ml-1 bg-primary/10 text-primary rounded-full px-1.5 py-0.5 text-[10px] font-bold">
                                {activeFilterCount}
                            </span>
                        )}
                    </Button>
                )}
            </div>

            {/* Active filter chips */}
            {activeFilterCount > 0 && (
                <div className="px-6 pb-3 flex flex-wrap gap-1.5">
                    {Object.entries(columnFilters).map(([key, val]) => {
                        const col = columns.find(c => c.key === key);
                        return (
                            <span key={key} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded-md">
                                <Filter className="h-3 w-3" />
                                {col?.header || key}: {val}
                                <button
                                    type="button"
                                    aria-label={t("aria.clearNamedFilter", {
                                        name: typeof col?.header === "string" ? col.header : key,
                                    })}
                                    onClick={() => setColumnFilter(key, "")}
                                    className="hover:text-destructive ml-0.5"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}

            <CardContent
                className="p-0"
                role="table"
                aria-rowcount={processedRows.length}
                aria-colcount={columns.length + (hasEditableColumns ? 1 : 0)}
            >
                {/* Sticky header */}
                <div ref={headerScrollRef} className="overflow-x-auto border-b border-border" role="rowgroup">
                    <div className="flex items-center bg-muted/50 min-h-[40px]" role="row">
                        {columns.map((col) => {
                            const width = columnWidths[col.key];
                            const isSortable = col.sortable !== false && !!col.header;
                            const isFilterable = col.filterable !== false && !!col.header;
                            const hasFilter = !!columnFilters[col.key];

                            const ariaSort = sortKey === col.key
                                ? (sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none")
                                : undefined;

                            return (
                                <div
                                    key={col.key}
                                    role="columnheader"
                                    aria-sort={ariaSort}
                                    className={cn("px-4 py-2 font-semibold text-muted-foreground text-sm relative select-none group flex-1 min-w-0 whitespace-nowrap", col.className || "")}
                                    style={width ? { width: `${width}px`, flex: "none" } : undefined}
                                >
                                    <div className="flex items-center gap-1">
                                        {isSortable ? (
                                            <button
                                                onClick={() => handleSort(col.key)}
                                                className="flex items-center gap-1 hover:text-foreground transition-colors text-left"
                                            >
                                                <span className="pr-0.5">{col.header}</span>
                                                <SortIcon colKey={col.key} />
                                            </button>
                                        ) : (
                                            <span className="pr-2">{col.header}</span>
                                        )}

                                        {isFilterable && col.header && (
                                            <Popover
                                                open={openFilter === col.key}
                                                onOpenChange={(open) => setOpenFilter(open ? col.key : null)}
                                            >
                                                <PopoverTrigger asChild>
                                                    <button
                                                        type="button"
                                                        aria-label={`Filter ${col.header}`}
                                                        className={cn("p-0.5 rounded transition-colors", hasFilter
                                                            ? "text-primary"
                                                            : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-foreground")}
                                                    >
                                                        <Filter className="h-3 w-3" />
                                                    </button>
                                                </PopoverTrigger>
                                                <PopoverContent className="w-56 p-2" align="start">
                                                    <ColumnFilter
                                                        header={typeof col.header === "string" ? col.header : ""}
                                                        value={columnFilters[col.key] || ""}
                                                        onChange={(v) => setColumnFilter(col.key, v)}
                                                        uniqueValues={openFilter === col.key ? openFilterUniqueValues : []}
                                                        onClose={() => setOpenFilter(null)}
                                                    />
                                                </PopoverContent>
                                            </Popover>
                                        )}
                                    </div>

                                    {col.header && (
                                        <div
                                            role="separator"
                                            aria-orientation="vertical"
                                            aria-label={typeof col.header === "string" ? col.header : col.key}
                                            aria-valuemin={col.minWidth || 60}
                                            aria-valuemax={MAX_COLUMN_WIDTH}
                                            aria-valuenow={Math.min(
                                                MAX_COLUMN_WIDTH,
                                                Math.max(col.minWidth || 60, columnWidths[col.key] ?? col.defaultWidth ?? 120),
                                            )}
                                            tabIndex={0}
                                            className="absolute -right-3 bottom-0 top-0 z-10 w-6 touch-none cursor-col-resize before:absolute before:inset-y-2 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:transition-[width,background-color] hover:before:w-0.5 hover:before:bg-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:before:w-0.5 focus-visible:before:bg-primary/70 active:before:bg-primary"
                                            onFocus={(e) => syncRenderedColumnWidth(
                                                e.currentTarget,
                                                col.key,
                                                columnWidths[col.key] ?? col.defaultWidth ?? 120,
                                            )}
                                            onPointerDown={(e) => handleResizeStart(
                                                e,
                                                col.key,
                                                syncRenderedColumnWidth(
                                                    e.currentTarget,
                                                    col.key,
                                                    columnWidths[col.key] ?? col.defaultWidth ?? 120,
                                                ),
                                            )}
                                            onKeyDown={(e) => handleResizeKeyDown(
                                                e,
                                                col.key,
                                                syncRenderedColumnWidth(
                                                    e.currentTarget,
                                                    col.key,
                                                    columnWidths[col.key] ?? col.defaultWidth ?? 120,
                                                ),
                                            )}
                                        />
                                    )}
                                </div>
                            );
                        })}
                        {hasEditableColumns && (
                            <div role="columnheader" className="px-2 py-2 text-right font-semibold text-muted-foreground text-sm" style={{ width: "40px", flex: "none" }}>
                                {t('table.edit')}
                            </div>
                        )}
                    </div>
                </div>

                {/* Virtualised scrollable body */}
                <div
                    ref={parentRef}
                    className="overflow-auto"
                    style={{ maxHeight: `${maxHeight}px` }}
                    role="rowgroup"
                    onScroll={(e) => {
                        // Mirror horizontal scroll onto the header (one-way).
                        const header = headerScrollRef.current;
                        if (header) header.scrollLeft = e.currentTarget.scrollLeft;
                    }}
                >
                    {processedRows.length === 0 ? (
                        // A `rowgroup` must contain a `row`, and a `row` must contain a
                        // cell (WCAG aria-required-children). Wrap the empty-state message
                        // in row+cell so the outer `role="table"` tree stays valid instead
                        // of having a bare `role="status"` as an (illegal) table child.
                        <div role="row">
                            <div role="cell" className="text-center text-muted-foreground py-12">
                                <span role="status">
                                    {localSearchQuery || activeFilterCount > 0
                                        ? t('table.noFilterResults')
                                        : (emptyMessage ?? t('table.noData'))}
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div role="presentation" style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                            {virtualizer.getVirtualItems().map((virtualRow, visibleIndex) => {
                                const indexedRow = processedRows[virtualRow.index];
                                if (!indexedRow) return null;
                                const row = indexedRow.row;
                                const sourceIndex = indexedRow.sourceIndex;
                                const isEditing = editingRow === sourceIndex;
                                // Key by the row's stable id, not the virtualizer's
                                // index-based key — on a sort/filter reorder an index
                                // key would re-attach in-progress inline edits and
                                // row transitions to the wrong row.
                                const rowKey = getRowKey(row, sourceIndex);
                                return (
                                    <MemoizedVirtualizedTableRow
                                        key={rowKey}
                                        row={row}
                                        sourceIndex={sourceIndex}
                                        virtualIndex={virtualRow.index}
                                        virtualStart={virtualRow.start}
                                        isFirstVisible={visibleIndex === 0}
                                        isEditing={isEditing}
                                        isCoarsePointer={isCoarsePointer}
                                        columns={columns}
                                        columnWidths={columnWidths}
                                        editValues={isEditing ? editValues : undefined}
                                        hasEditableColumns={hasEditableColumns}
                                        measureElement={virtualizer.measureElement}
                                        onRowDoubleClick={onRowDoubleClick}
                                        onRowOpen={onRowOpen}
                                        onRowQuickLook={onRowQuickLook}
                                        rowContextMenu={rowContextMenu}
                                        startEditing={startEditing}
                                        saveEditing={isEditing ? saveEditing : undefined}
                                        cancelEditing={cancelEditing}
                                        setEditValues={setEditValues}
                                        focusRowByIndex={onRowDoubleClick || onRowOpen || onRowQuickLook ? focusRowByIndex : undefined}
                                        saveLabel={t('aria.save')}
                                        cancelLabel={t('aria.cancel')}
                                        editLabel={t('aria.edit')}
                                    />
                                );
                            })}
                        </div>
                    )}

                    {/* Loading more indicator */}
                    {isFetchingMore && (
                        <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span className="text-sm">{t('table.loadingMore')}</span>
                        </div>
                    )}
                </div>

                {/* Footer: count */}
                <div className="flex items-center justify-between border-t px-6 py-3">
                    <p className="text-sm text-muted-foreground">
                        {processedRows.length !== deferredData.length
                            ? t('table.shownOfFiltered', { shown: processedRows.length.toString(), total: displayTotal.toString() })
                            : t('table.loadedOf', { loaded: deferredData.length.toString(), total: displayTotal.toString() })}
                        {hasMore && ` · ${t('table.scrollForMore')}`}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
