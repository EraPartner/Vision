import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    ArrowDown, ArrowUp, ArrowUpDown, Check, Filter, Loader2,
    Pencil, Search, X,
} from "lucide-react";

type SortDirection = "asc" | "desc" | null;

interface Column<T> {
    key: string;
    header: string;
    editable?: boolean;
    type?: "text" | "number" | "date";
    render?: (row: T, isEditing: boolean, index?: number) => React.ReactNode;
    className?: string;
    minWidth?: number;
    defaultWidth?: number;
    sortable?: boolean;
    filterable?: boolean;
}

interface VirtualDataTableProps<T> {
    title: string;
    subtitle?: string;
    columns: Column<T>[];
    data: T[];
    emptyMessage?: string;
    actions?: React.ReactNode;
    onRowUpdate?: (index: number, updatedRow: T) => void;
    /** Called when a row is double-clicked */
    onRowDoubleClick?: (row: T, index: number) => void;
    /** Total items available on server */
    totalItems?: number;
    /** Whether more data is currently being fetched */
    isFetchingMore?: boolean;
    /** Called when the user scrolls near the bottom and more data should be loaded */
    onLoadMore?: () => void;
    /** Whether there are more items to load */
    hasMore?: boolean;
    /** Server-side search callback */
    onSearchChange?: (query: string) => void;
    searchValue?: string;
    /** Height of the virtual scroll container. Defaults to 600 */
    maxHeight?: number;
    /** Estimated row height for virtualizer */
    rowHeight?: number;
}

function getSortValue(val: any): string | number {
    if (val == null) return "";
    if (typeof val === "number") return val;
    if (typeof val === "boolean") return val ? 1 : 0;
    return String(val).toLowerCase();
}

export function VirtualDataTable<T extends Record<string, any>>({
    title,
    subtitle,
    columns,
    data,
    emptyMessage = "No data available",
    actions,
    onRowUpdate,
    onRowDoubleClick,
    totalItems,
    isFetchingMore = false,
    onLoadMore,
    hasMore = false,
    onSearchChange,
    searchValue,
    maxHeight = 600,
    rowHeight = 44,
}: VirtualDataTableProps<T>) {
    const [editingRow, setEditingRow] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Record<string, any>>({});
    const [localSearchQuery, setLocalSearchQuery] = useState("");
    const isServerSearch = !!onSearchChange;
    const searchQuery = isServerSearch ? (searchValue ?? "") : localSearchQuery;

    // Debounced server search
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleSearchInput = useCallback((value: string) => {
        setLocalSearchQuery(value);
        if (isServerSearch) {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
                onSearchChange!(value);
            }, 350);
        }
    }, [isServerSearch, onSearchChange]);

    const [sortKey, setSortKey] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<SortDirection>(null);
    const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
    const [openFilter, setOpenFilter] = useState<string | null>(null);
    const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
        const widths: Record<string, number> = {};
        columns.forEach((col) => {
            if (col.defaultWidth) widths[col.key] = col.defaultWidth;
        });
        return widths;
    });

    const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

    const handleResizeStart = useCallback((e: React.MouseEvent, colKey: string, currentWidth: number) => {
        e.preventDefault();
        resizingRef.current = { key: colKey, startX: e.clientX, startWidth: currentWidth };
        const handleMouseMove = (ev: MouseEvent) => {
            if (!resizingRef.current) return;
            const diff = ev.clientX - resizingRef.current.startX;
            const col = columns.find(c => c.key === resizingRef.current!.key);
            const minW = col?.minWidth || 60;
            const newWidth = Math.max(minW, resizingRef.current.startWidth + diff);
            setColumnWidths(prev => ({ ...prev, [resizingRef.current!.key]: newWidth }));
        };
        const handleMouseUp = () => {
            resizingRef.current = null;
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
    }, [columns]);

    const handleSort = (key: string) => {
        if (sortKey === key) {
            if (sortDir === "asc") setSortDir("desc");
            else if (sortDir === "desc") { setSortKey(null); setSortDir(null); }
            else setSortDir("asc");
        } else {
            setSortKey(key);
            setSortDir("asc");
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

    const uniqueValues = useMemo(() => {
        const result: Record<string, string[]> = {};
        columns.forEach((col) => {
            if (col.filterable === false || !col.header) return;
            const vals = new Set<string>();
            data.forEach((row) => {
                const v = row[col.key];
                if (v != null && String(v).trim()) vals.add(String(v));
            });
            result[col.key] = Array.from(vals).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        });
        return result;
    }, [data, columns]);

    // Client-side filter/sort pipeline
    const processedData = useMemo(() => {
        let result = [...data];

        for (const [key, filterVal] of Object.entries(columnFilters)) {
            const q = filterVal.toLowerCase();
            result = result.filter((row) => {
                const v = row[key];
                return v != null && String(v).toLowerCase().includes(q);
            });
        }

        if (!isServerSearch && localSearchQuery.trim()) {
            const q = localSearchQuery.toLowerCase();
            result = result.filter((row) =>
                columns.some((col) => {
                    const val = row[col.key];
                    return val != null && String(val).toLowerCase().includes(q);
                })
            );
        }

        if (sortKey && sortDir) {
            result.sort((a, b) => {
                const va = getSortValue(a[sortKey]);
                const vb = getSortValue(b[sortKey]);
                let cmp = 0;
                if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
                else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
                return sortDir === "desc" ? -cmp : cmp;
            });
        }

        return result;
    }, [data, columnFilters, localSearchQuery, isServerSearch, sortKey, sortDir, columns]);

    // Virtualizer
    const parentRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: processedData.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => rowHeight,
        overscan: 10,
    });

    // Infinite scroll: load more when near bottom
    useEffect(() => {
        if (!onLoadMore || !hasMore || isFetchingMore) return;

        const items = virtualizer.getVirtualItems();
        if (items.length === 0) return;

        const lastItem = items[items.length - 1];
        if (lastItem && lastItem.index >= processedData.length - 15) {
            onLoadMore();
        }
    }, [virtualizer.getVirtualItems(), processedData.length, onLoadMore, hasMore, isFetchingMore]);

    const startEditing = (idx: number, row: T) => {
        setEditingRow(idx);
        const values: Record<string, any> = {};
        columns.forEach((col) => {
            if (col.editable) values[col.key] = row[col.key];
        });
        setEditValues(values);
    };

    const cancelEditing = () => { setEditingRow(null); setEditValues({}); };

    const saveEditing = (idx: number) => {
        if (onRowUpdate) {
            const updatedRow = { ...processedData[idx], ...editValues } as T;
            // Find original index in data array
            const originalIdx = data.indexOf(processedData[idx]);
            onRowUpdate(originalIdx >= 0 ? originalIdx : idx, updatedRow);
        }
        setEditingRow(null);
        setEditValues({});
    };

    const clearAllFilters = () => {
        setColumnFilters({});
        setLocalSearchQuery("");
        if (isServerSearch) onSearchChange!("");
        setSortKey(null);
        setSortDir(null);
    };

    const hasEditableColumns = columns.some((c) => c.editable);
    const displayTotal = totalItems ?? data.length;

    const SortIcon = ({ colKey }: { colKey: string }) => {
        if (sortKey !== colKey) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
        if (sortDir === "asc") return <ArrowUp className="h-3 w-3 text-primary" />;
        return <ArrowDown className="h-3 w-3 text-primary" />;
    };

    return (
        <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16" />
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
                <div>
                    <CardTitle className="text-lg font-semibold">{title}</CardTitle>
                    {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </CardHeader>

            {/* Search bar */}
            <div className="px-6 pb-3 flex items-center gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={isServerSearch ? "Search database…" : "Search across all columns…"}
                        value={localSearchQuery}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        className="pl-9 h-9"
                    />
                    {localSearchQuery && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground"
                            onClick={() => { setLocalSearchQuery(""); if (isServerSearch) onSearchChange!(""); }}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                </div>
                {(activeFilterCount > 0 || localSearchQuery || sortKey) && (
                    <Button
                        variant="ghost" size="sm"
                        onClick={clearAllFilters}
                        className="text-xs text-muted-foreground hover:text-destructive shrink-0 gap-1"
                    >
                        <X className="h-3 w-3" /> Clear all
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
                                <button onClick={() => setColumnFilter(key, "")} className="hover:text-destructive ml-0.5">
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}

            <CardContent className="p-0">
                {/* Sticky header */}
                <div className="overflow-x-auto border-b border-border">
                    <div className="flex items-center bg-muted/50 min-h-[40px]">
                        {columns.map((col) => {
                            const width = columnWidths[col.key];
                            const isSortable = col.sortable !== false && !!col.header;
                            const isFilterable = col.filterable !== false && !!col.header;
                            const hasFilter = !!columnFilters[col.key];

                            return (
                                <div
                                    key={col.key}
                                    className={`px-4 py-2 font-semibold text-muted-foreground text-sm relative select-none group flex-1 min-w-0 ${col.className || ""}`}
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
                                                    <button className={`p-0.5 rounded transition-colors ${
                                                        hasFilter
                                                            ? "text-primary"
                                                            : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-foreground"
                                                    }`}>
                                                        <Filter className="h-3 w-3" />
                                                    </button>
                                                </PopoverTrigger>
                                                <PopoverContent className="w-56 p-2" align="start">
                                                    <ColumnFilter
                                                        columnKey={col.key}
                                                        header={col.header}
                                                        value={columnFilters[col.key] || ""}
                                                        onChange={(v) => setColumnFilter(col.key, v)}
                                                        uniqueValues={uniqueValues[col.key] || []}
                                                        onClose={() => setOpenFilter(null)}
                                                    />
                                                </PopoverContent>
                                            </Popover>
                                        )}
                                    </div>

                                    {col.header && (
                                        <div
                                            className="absolute right-0 top-2 bottom-2 w-px bg-border cursor-col-resize hover:w-0.5 hover:bg-primary/50 active:bg-primary transition-all"
                                            onMouseDown={(e) => {
                                                const el = e.currentTarget.parentElement;
                                                const currentWidth = el ? el.getBoundingClientRect().width : 120;
                                                handleResizeStart(e, col.key, currentWidth);
                                            }}
                                        />
                                    )}
                                </div>
                            );
                        })}
                        {hasEditableColumns && (
                            <div className="px-4 py-2 text-right font-semibold text-muted-foreground text-sm" style={{ width: "96px", flex: "none" }}>
                                Edit
                            </div>
                        )}
                    </div>
                </div>

                {/* Virtualised scrollable body */}
                <div
                    ref={parentRef}
                    className="overflow-auto"
                    style={{ maxHeight: `${maxHeight}px` }}
                >
                    {processedData.length === 0 ? (
                        <div className="text-center text-muted-foreground py-12">
                            {localSearchQuery || activeFilterCount > 0
                                ? "No results match your filters."
                                : emptyMessage}
                        </div>
                    ) : (
                        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                                    {virtualizer.getVirtualItems().map((virtualRow) => {
                                        const row = processedData[virtualRow.index];
                                        const idx = virtualRow.index;
                                        const isEditing = editingRow === idx;

                                        return (
                                            <div
                                                key={virtualRow.key}
                                                data-index={virtualRow.index}
                                                ref={virtualizer.measureElement}
                                                className={`flex items-center border-b border-border transition-colors hover:bg-muted/50 ${isEditing ? "bg-primary/5" : ""}`}
                                                style={{
                                                    position: "absolute",
                                                    top: 0,
                                                    left: 0,
                                                    width: "100%",
                                                    transform: `translateY(${virtualRow.start}px)`,
                                                }}
                                            >
                                                {columns.map((col) => {
                                                    const width = columnWidths[col.key];
                                                    return (
                                                        <div
                                                            key={col.key}
                                                            className={`px-4 py-2 text-sm flex-1 min-w-0 ${col.className || ""}`}
                                                            style={width ? { width: `${width}px`, flex: "none" } : undefined}
                                                        >
                                                            {isEditing && col.editable ? (
                                                                <Input
                                                                    type={col.type || "text"}
                                                                    value={editValues[col.key] ?? ""}
                                                                    onChange={(e) =>
                                                                        setEditValues((prev) => ({
                                                                            ...prev,
                                                                            [col.key]: col.type === "number"
                                                                                ? parseFloat(e.target.value) || 0
                                                                                : e.target.value,
                                                                        }))
                                                                    }
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === "Enter") { e.preventDefault(); saveEditing(idx); }
                                                                        else if (e.key === "Escape") { e.preventDefault(); cancelEditing(); }
                                                                    }}
                                                                    className="h-8 text-sm"
                                                                />
                                                            ) : col.render ? (
                                                                col.render(row, isEditing, idx)
                                                            ) : (
                                                                String(row[col.key] ?? "")
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                                {hasEditableColumns && (
                                                    <div className="px-4 py-2 text-right" style={{ width: "96px", flex: "none" }}>
                                                        {isEditing ? (
                                                            <div className="flex items-center justify-end gap-1">
                                                                <Button variant="ghost" size="icon"
                                                                    className="h-8 w-8 text-accent hover:text-accent hover:bg-accent/10"
                                                                    onClick={() => saveEditing(idx)}>
                                                                    <Check className="h-4 w-4" />
                                                                </Button>
                                                                <Button variant="ghost" size="icon"
                                                                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                                    onClick={cancelEditing}>
                                                                    <X className="h-4 w-4" />
                                                                </Button>
                                                            </div>
                                                        ) : (
                                                            <Button variant="ghost" size="icon"
                                                                className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                                                                onClick={() => startEditing(idx, row)}>
                                                                <Pencil className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                        </div>
                    )}

                    {/* Loading more indicator */}
                    {isFetchingMore && (
                        <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span className="text-sm">Loading more…</span>
                        </div>
                    )}
                </div>

                {/* Footer: count */}
                <div className="flex items-center justify-between border-t px-6 py-3">
                    <p className="text-sm text-muted-foreground">
                        {processedData.length !== data.length
                            ? `${processedData.length} of ${displayTotal} shown (filtered)`
                            : `${data.length} of ${displayTotal} loaded`}
                        {hasMore && " · Scroll for more"}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}

// ─── Column Filter (same as DataTable) ──────────────────────
function ColumnFilter({
    columnKey,
    header,
    value,
    onChange,
    uniqueValues,
    onClose,
}: {
    columnKey: string;
    header: string;
    value: string;
    onChange: (val: string) => void;
    uniqueValues: string[];
    onClose: () => void;
}) {
    const [filterSearch, setFilterSearch] = useState("");
    const filtered = uniqueValues.filter(v =>
        v.toLowerCase().includes(filterSearch.toLowerCase())
    );

    return (
        <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground px-1">Filter: {header}</p>
            <Input
                placeholder={`Filter ${header.toLowerCase()}…`}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="h-8 text-sm"
                autoFocus
                onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); onClose(); }
                    if (e.key === "Escape") { e.preventDefault(); onChange(""); onClose(); }
                }}
            />
            {uniqueValues.length > 0 && uniqueValues.length <= 100 && (
                <>
                    {uniqueValues.length > 8 && (
                        <Input
                            placeholder="Search values…"
                            value={filterSearch}
                            onChange={(e) => setFilterSearch(e.target.value)}
                            className="h-7 text-xs"
                        />
                    )}
                    <div className="max-h-40 overflow-y-auto space-y-0.5">
                        {filtered.slice(0, 30).map((v) => (
                            <button
                                key={v}
                                onClick={() => { onChange(v); onClose(); }}
                                className={`w-full text-left text-xs px-2 py-1 rounded hover:bg-muted transition-colors truncate ${
                                    value === v ? "bg-primary/10 text-primary font-medium" : "text-foreground"
                                }`}
                            >
                                {v}
                            </button>
                        ))}
                        {filtered.length > 30 && (
                            <p className="text-[10px] text-muted-foreground px-2">+{filtered.length - 30} more…</p>
                        )}
                    </div>
                </>
            )}
            {value && (
                <Button variant="ghost" size="sm" onClick={() => { onChange(""); onClose(); }}
                    className="w-full text-xs h-7 text-muted-foreground">
                    Clear filter
                </Button>
            )}
        </div>
    );
}
