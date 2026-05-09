import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { parseDecimal } from "@/lib/decimal";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    ArrowDown, ArrowUp, ArrowUpDown, Check, Filter, Loader2,
    Pencil, Search, X,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { ColumnFilter } from "@/components/shared/ColumnFilter";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import type { Column } from "@/types/dataTable";

export type { Column };

type SortDirection = "asc" | "desc" | null;

interface VirtualDataTableProps<T> {
    title: string;
    subtitle?: string;
    columns: Column<T>[];
    data: T[];
    emptyMessage?: React.ReactNode;
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
    /** Number of rows from the end before triggering onLoadMore */
    loadMoreOffset?: number;
    /** Server-side search callback */
    onSearchChange?: (query: string) => void;
    searchValue?: string;
    /**
     * When provided the table operates in server-sort mode: clicking a column
     * header calls onSortChange instead of sorting locally. This ensures the
     * full dataset (not just the loaded page) is sorted by the server.
     */
    onSortChange?: (key: string | null, dir: SortDirection) => void;
    /** Controlled sort key (server-sort mode) */
    sortKeyProp?: string | null;
    /** Controlled sort direction (server-sort mode) */
    sortDirProp?: SortDirection;
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

export function VirtualDataTable<T extends Record<string, unknown>>({
    title,
    subtitle,
    columns,
    data,
    emptyMessage,
    actions,
    onRowUpdate,
    onRowDoubleClick,
    totalItems,
    isFetchingMore = false,
    onLoadMore,
    hasMore = false,
    loadMoreOffset = 15,
    onSearchChange,
    searchValue,
    onSortChange,
    sortKeyProp,
    sortDirProp,
    maxHeight = 600,
    rowHeight = 44,
    cancelEditingRef,
    onEditingChange,
}: VirtualDataTableProps<T>) {
    const { t } = useLanguage();
    const isServerSort = !!onSortChange;
    const [editingRow, setEditingRow] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Record<string, unknown>>({});
    const isServerSearch = !!onSearchChange;
    const [localSearchQuery, setLocalSearchQuery] = useState(searchValue ?? "");

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
                onSearchChange!(value);
                debounceRef.current = null;
                isTypingRef.current = false;
            }, 200);
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
        if (!isTypingRef.current && externalQuery !== localSearchQuery) {
            setLocalSearchQuery(externalQuery);
        }
    }, [isServerSearch, searchValue, localSearchQuery]);

    useEffect(() => clearPendingSearch, [clearPendingSearch]);

    // In server-sort mode use controlled props; otherwise use local state
    const [localSortKey, setLocalSortKey] = useState<string | null>(null);
    const [localSortDir, setLocalSortDir] = useState<SortDirection>(null);
    const sortKey = isServerSort ? (sortKeyProp ?? null) : localSortKey;
    const sortDir = isServerSort ? (sortDirProp ?? null) : localSortDir;

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

    const deferredData = useDeferredValue(data);

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
                columns.some((col) => {
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
    }, [deferredData, columnFilters, localSearchQuery, isServerSearch, isServerSort, sortKey, sortDir, columns]);

    // Virtualizer
    const parentRef = useRef<HTMLDivElement>(null);
    const loadRequestedForLengthRef = useRef<number | null>(null);
    const virtualizer = useVirtualizer({
        count: processedRows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => rowHeight,
        overscan: 10,
    });

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

    useEffect(() => {
        loadRequestedForLengthRef.current = null;
    }, [processedRows.length]);

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

    const startEditing = (sourceIndex: number, row: T) => {
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
    };

    const saveEditing = (sourceIndex: number, row: T) => {
        if (onRowUpdate) {
            const updatedRow = { ...row, ...editValues } as T;
            onRowUpdate(sourceIndex, updatedRow);
        }
        setEditingRow(null);
        setEditValues({});
    };

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
        <Card className="surface-elevated premium-frame micro-lift relative overflow-hidden">
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
                        placeholder={isServerSearch ? t('table.searchDatabase') : t('table.searchAllColumns')}
                        value={localSearchQuery}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        className="pl-9 h-9"
                    />
                    {localSearchQuery && (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Clear search"
                            className="absolute right-1 top-1/2 -translate-y-1/2 icon-touch-target text-muted-foreground"
                            onClick={clearSearch}
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
                                    className={`px-4 py-2 font-semibold text-muted-foreground text-sm relative select-none group flex-1 min-w-0 whitespace-nowrap ${col.className || ""}`}
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
                                                        className={`p-0.5 rounded transition-colors ${hasFilter
                                                            ? "text-primary"
                                                            : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-foreground"
                                                            }`}
                                                    >
                                                        <Filter className="h-3 w-3" />
                                                    </button>
                                                </PopoverTrigger>
                                                <PopoverContent className="w-56 p-2" align="start">
                                                    <ColumnFilter
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
                            <div className="px-2 py-2 text-right font-semibold text-muted-foreground text-sm" style={{ width: "40px", flex: "none" }}>
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
                >
                    {processedRows.length === 0 ? (
                        <div className="text-center text-muted-foreground py-12">
                            {localSearchQuery || activeFilterCount > 0
                                ? t('table.noFilterResults')
                                : (emptyMessage ?? t('table.noData'))}
                        </div>
                    ) : (
                        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                            {virtualizer.getVirtualItems().map((virtualRow) => {
                                const indexedRow = processedRows[virtualRow.index];
                                if (!indexedRow) return null;
                                const row = indexedRow.row;
                                const sourceIndex = indexedRow.sourceIndex;
                                const isEditing = editingRow === sourceIndex;

                                return (
                                    <div
                                        key={virtualRow.key}
                                        data-index={virtualRow.index}
                                        ref={virtualizer.measureElement}
                                        className={`flex items-center border-b border-border transition-colors hover:bg-muted/50 ${isEditing ? "bg-primary/5" : ""} ${onRowDoubleClick ? "cursor-pointer" : ""}`}
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                        onDoubleClick={() => {
                                            if (onRowDoubleClick) {
                                                onRowDoubleClick(row, sourceIndex);
                                            } else if (hasEditableColumns && !isEditing) {
                                                startEditing(sourceIndex, row);
                                            }
                                        }}
                                    >
                                        {columns.map((col) => {
                                            const width = columnWidths[col.key];
                                            return (
                                                <div
                                                    key={col.key}
                                                    className={`px-4 py-2 text-sm flex-1 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] ${col.className || ""}`}
                                                    style={width ? { width: `${width}px`, flex: "none" } : undefined}
                                                >
                                                    {isEditing && col.editable ? (
                                                        col.type === "date" ? (
                                                            <DatePicker
                                                                value={editValues[col.key] ? parseLocalDateFromYmd(String(editValues[col.key])) : undefined}
                                                                onChange={(d) => setEditValues((prev) => ({ ...prev, [col.key]: d ? toYmd(d) : "" }))}
                                                                buttonClassName="h-8 text-sm w-full"
                                                            />
                                                        ) : (
                                                            <Input
                                                                type={col.type || "text"}
                                                                value={editValues[col.key] ?? ""}
                                                                onChange={(e) =>
                                                                    setEditValues((prev) => ({
                                                                        ...prev,
                                                                        [col.key]: col.type === "number"
                                                                            ? parseDecimal(e.target.value)
                                                                            : e.target.value,
                                                                    }))
                                                                }
                                                                onKeyDown={(e) => {
                                                                    if (e.key === "Enter") { e.preventDefault(); saveEditing(sourceIndex, row); }
                                                                    else if (e.key === "Escape") { e.preventDefault(); cancelEditing(); }
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
                                            <div className="px-1 py-2 text-right" style={{ width: isEditing ? "88px" : "40px", flex: "none" }}>
                                                {isEditing ? (
                                                    <div className="flex items-center justify-end gap-1">
                                                        <Button variant="ghost" size="icon" aria-label="Save"
                                                            className="icon-touch-target text-accent hover:text-accent hover:bg-accent/10"
                                                            onClick={() => saveEditing(sourceIndex, row)}>
                                                            <Check className="h-4 w-4" />
                                                        </Button>
                                                        <Button variant="ghost" size="icon" aria-label="Cancel"
                                                            className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                            onClick={cancelEditing}>
                                                            <X className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <Button variant="ghost" size="icon" aria-label="Edit"
                                                        className="icon-touch-target text-muted-foreground hover:text-primary hover:bg-primary/10"
                                                        onClick={() => startEditing(sourceIndex, row)}>
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
                            <span className="text-sm">{t('table.loadingMore')}</span>
                        </div>
                    )}
                </div>

                {/* Footer: count */}
                <div className="flex items-center justify-between border-t px-6 py-3">
                    <p className="text-sm text-muted-foreground">
                        {processedRows.length !== data.length
                            ? t('table.shownOfFiltered', { shown: processedRows.length.toString(), total: displayTotal.toString() })
                            : t('table.loadedOf', { loaded: data.length.toString(), total: displayTotal.toString() })}
                        {hasMore && ` · ${t('table.scrollForMore')}`}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
