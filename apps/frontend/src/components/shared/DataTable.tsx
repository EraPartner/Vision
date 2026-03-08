import {useCallback, useMemo, useRef, useState} from "react";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import {Input} from "@/components/ui/input";
import {Button} from "@/components/ui/button";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, Filter, Pencil, Search, X} from "lucide-react";

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
    sortable?: boolean;    // default true if header exists
    filterable?: boolean;  // default true if header exists
}

interface DataTableProps<T> {
    title: string;
    subtitle?: string;
    columns: Column<T>[];
    data: T[];
    emptyMessage?: string;
    actions?: React.ReactNode;
    onRowUpdate?: (index: number, updatedRow: T) => void;
    page?: number;
    pageSize?: number;
    totalItems?: number;
    onPageChange?: (page: number) => void;
    /** When provided, search is delegated to the server. The DataTable will call this with the debounced search string instead of filtering locally. */
    onSearchChange?: (query: string) => void;
    /** Controlled search value (for server-side search) */
    searchValue?: string;
}

function getSortValue(val: any): string | number {
    if (val == null) return "";
    if (typeof val === "number") return val;
    if (typeof val === "boolean") return val ? 1 : 0;
    return String(val).toLowerCase();
}

export function DataTable<T extends Record<string, any>>({
    title,
    subtitle,
    columns,
    data,
    emptyMessage = "No data available",
    actions,
    onRowUpdate,
    page,
    pageSize = 50,
    totalItems,
    onPageChange,
    onSearchChange,
    searchValue,
}: DataTableProps<T>) {
    const [editingRow, setEditingRow] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Record<string, any>>({});
    const [localSearchQuery, setLocalSearchQuery] = useState("");
    const isServerSearch = !!onSearchChange;
    const searchQuery = isServerSearch ? (searchValue ?? "") : localSearchQuery;

    // Debounced server-side search
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleSearchInput = useCallback((value: string) => {
        if (isServerSearch) {
            // Update local display immediately
            setLocalSearchQuery(value);
            // Debounce the server call
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
                onSearchChange!(value);
                // Reset to page 0 on new search
                if (onPageChange) onPageChange(0);
            }, 350);
        } else {
            setLocalSearchQuery(value);
        }
    }, [isServerSearch, onSearchChange, onPageChange]);
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

    // Handle sort toggle
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

    // Update column filter
    const setColumnFilter = (key: string, value: string) => {
        setColumnFilters(prev => {
            const next = { ...prev };
            if (value) next[key] = value;
            else delete next[key];
            return next;
        });
    };

    const activeFilterCount = Object.keys(columnFilters).length;

    // Get unique values for filter dropdowns
    const uniqueValues = useMemo(() => {
        const result: Record<string, string[]> = {};
        columns.forEach((col) => {
            if (col.filterable === false || !col.header) return;
            const vals = new Set<string>();
            data.forEach((row) => {
                const v = row[col.key];
                if (v != null && String(v).trim()) vals.add(String(v));
            });
            const sorted = Array.from(vals).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            result[col.key] = sorted;
        });
        return result;
    }, [data, columns]);

    // Filter + search + sort pipeline
    const processedData = useMemo(() => {
        let result = [...data];

        // Apply column filters
        for (const [key, filterVal] of Object.entries(columnFilters)) {
            const q = filterVal.toLowerCase();
            result = result.filter((row) => {
                const v = row[key];
                return v != null && String(v).toLowerCase().includes(q);
            });
        }

        // Apply global search (only for client-side search)
        if (!isServerSearch && localSearchQuery.trim()) {
            const q = localSearchQuery.toLowerCase();
            result = result.filter((row) =>
                columns.some((col) => {
                    const val = row[col.key];
                    return val != null && String(val).toLowerCase().includes(q);
                })
            );
        }

        // Apply sort
        if (sortKey && sortDir) {
            result.sort((a, b) => {
                const va = getSortValue(a[sortKey]);
                const vb = getSortValue(b[sortKey]);
                let cmp = 0;
                if (typeof va === "number" && typeof vb === "number") {
                    cmp = va - vb;
                } else {
                    cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
                }
                return sortDir === "desc" ? -cmp : cmp;
            });
        }

        return result;
    }, [data, columnFilters, searchQuery, sortKey, sortDir, columns]);

    const startEditing = (idx: number, row: T) => {
        setEditingRow(idx);
        const values: Record<string, any> = {};
        columns.forEach((col) => {
            if (col.editable) {
                values[col.key] = row[col.key];
            }
        });
        setEditValues(values);
    };

    const cancelEditing = () => {
        setEditingRow(null);
        setEditValues({});
    };

    const saveEditing = (idx: number) => {
        if (onRowUpdate) {
            const updatedRow = {...data[idx], ...editValues} as T;
            onRowUpdate(idx, updatedRow);
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
    const hasPagination = page !== undefined && totalItems !== undefined && onPageChange;
    const totalPages = hasPagination ? Math.max(1, Math.ceil(totalItems! / pageSize)) : 1;
    const currentPage = page ?? 0;

    const SortIcon = ({ colKey }: { colKey: string }) => {
        if (sortKey !== colKey) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
        if (sortDir === "asc") return <ArrowUp className="h-3 w-3 text-primary" />;
        return <ArrowDown className="h-3 w-3 text-primary" />;
    };

    return (
        <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
                <div>
                    <CardTitle className="text-lg font-semibold">{title}</CardTitle>
                    {subtitle && (
                        <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
                    )}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </CardHeader>

            {/* Search + filter status bar */}
            <div className="px-6 pb-3 flex items-center gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={isServerSearch ? "Search database…" : "Search across all columns…"}
                        value={isServerSearch ? localSearchQuery : localSearchQuery}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        className="pl-9 h-9"
                    />
                    {searchQuery && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground"
                            onClick={() => setSearchQuery("")}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                </div>
                {(activeFilterCount > 0 || searchQuery || sortKey) && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={clearAllFilters}
                        className="text-xs text-muted-foreground hover:text-destructive shrink-0 gap-1"
                    >
                        <X className="h-3 w-3" />
                        Clear all
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
                            <span
                                key={key}
                                className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded-md"
                            >
                                <Filter className="h-3 w-3" />
                                {col?.header || key}: {val}
                                <button
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

            <CardContent className="p-0">
                <div className="overflow-x-auto">
                    <Table style={{ tableLayout: "fixed" }}>
                        <TableHeader>
                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                                {columns.map((col) => {
                                    const width = columnWidths[col.key];
                                    const isSortable = col.sortable !== false && !!col.header;
                                    const isFilterable = col.filterable !== false && !!col.header;
                                    const hasFilter = !!columnFilters[col.key];

                                    return (
                                        <TableHead
                                            key={col.key}
                                            className={`font-semibold text-muted-foreground relative select-none group ${col.className || ""}`}
                                            style={width ? { width: `${width}px` } : undefined}
                                        >
                                            <div className="flex items-center gap-1">
                                                {/* Sortable header */}
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

                                                {/* Column filter */}
                                                {isFilterable && col.header && (
                                                    <Popover
                                                        open={openFilter === col.key}
                                                        onOpenChange={(open) => setOpenFilter(open ? col.key : null)}
                                                    >
                                                        <PopoverTrigger asChild>
                                                            <button
                                                                className={`p-0.5 rounded transition-colors ${
                                                                    hasFilter
                                                                        ? "text-primary"
                                                                        : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-foreground"
                                                                }`}
                                                            >
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

                                            {/* Resize handle */}
                                            {col.header && (
                                                <div
                                                    className="absolute right-0 top-2 bottom-2 w-px bg-border cursor-col-resize hover:w-0.5 hover:bg-primary/50 active:bg-primary transition-all"
                                                    onMouseDown={(e) => {
                                                        const th = e.currentTarget.parentElement;
                                                        const currentWidth = th ? th.getBoundingClientRect().width : 120;
                                                        handleResizeStart(e, col.key, currentWidth);
                                                    }}
                                                />
                                            )}
                                        </TableHead>
                                    );
                                })}
                                {hasEditableColumns && (
                                    <TableHead className="w-24 text-right font-semibold text-muted-foreground">
                                        Edit
                                    </TableHead>
                                )}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {processedData.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={columns.length + (hasEditableColumns ? 1 : 0)}
                                        className="text-center text-muted-foreground py-12"
                                    >
                                        {searchQuery || activeFilterCount > 0
                                            ? "No results match your filters."
                                            : emptyMessage}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                processedData.map((row, idx) => {
                                    const isEditing = editingRow === idx;
                                    return (
                                        <TableRow
                                            key={idx}
                                            className={`transition-colors ${isEditing ? "bg-primary/5" : ""}`}
                                        >
                                            {columns.map((col) => (
                                                <TableCell key={col.key} className={col.className || ""}>
                                                    {isEditing && col.editable ? (
                                                        <Input
                                                            type={col.type || "text"}
                                                            value={editValues[col.key] ?? ""}
                                                            onChange={(e) =>
                                                                setEditValues((prev) => ({
                                                                    ...prev,
                                                                    [col.key]:
                                                                        col.type === "number"
                                                                            ? parseFloat(e.target.value) || 0
                                                                            : e.target.value,
                                                                }))
                                                            }
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") {
                                                                    e.preventDefault();
                                                                    saveEditing(idx);
                                                                } else if (e.key === "Escape") {
                                                                    e.preventDefault();
                                                                    cancelEditing();
                                                                }
                                                            }}
                                                            className="h-8 text-sm"
                                                        />
                                                    ) : col.render ? (
                                                        col.render(row, isEditing, idx)
                                                    ) : (
                                                        String(row[col.key] ?? "")
                                                    )}
                                                </TableCell>
                                            ))}
                                            {hasEditableColumns && (
                                                <TableCell className="text-right">
                                                    {isEditing ? (
                                                        <div className="flex items-center justify-end gap-1">
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-8 w-8 text-accent hover:text-accent hover:bg-accent/10"
                                                                onClick={() => saveEditing(idx)}
                                                            >
                                                                <Check className="h-4 w-4"/>
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                                onClick={cancelEditing}
                                                            >
                                                                <X className="h-4 w-4"/>
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                                                            onClick={() => startEditing(idx, row)}
                                                        >
                                                            <Pencil className="h-4 w-4"/>
                                                        </Button>
                                                    )}
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    );
                                })
                            )}
                        </TableBody>
                    </Table>
                </div>

                {/* Result count + Pagination */}
                <div className="flex items-center justify-between border-t px-6 py-3">
                    <p className="text-sm text-muted-foreground">
                        {processedData.length !== data.length
                            ? `${processedData.length} of ${hasPagination ? totalItems : data.length} shown`
                            : hasPagination && totalItems! > 0
                                ? `Showing ${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, totalItems!)} of ${totalItems!}`
                                : `${data.length} items`
                        }
                    </p>
                    {hasPagination && totalItems! > 0 && (
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={totalPages <= 1}
                                onClick={() => {
                                    if (currentPage === 0) onPageChange!(totalPages - 1);
                                    else onPageChange!(currentPage - 1);
                                }}
                            >
                                <ChevronLeft className="h-4 w-4 mr-1" />
                                Previous
                            </Button>
                            <span className="text-sm text-muted-foreground px-2">
                                Page {currentPage + 1} of {totalPages}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={totalPages <= 1}
                                onClick={() => {
                                    if (currentPage >= totalPages - 1) onPageChange!(0);
                                    else onPageChange!(currentPage + 1);
                                }}
                            >
                                Next
                                <ChevronRight className="h-4 w-4 ml-1" />
                            </Button>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

// ─── Column Filter Component ──────────────────────────────
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
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { onChange(""); onClose(); }}
                    className="w-full text-xs h-7 text-muted-foreground"
                >
                    Clear filter
                </Button>
            )}
        </div>
    );
}
