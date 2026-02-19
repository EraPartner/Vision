import {useCallback, useMemo, useRef, useState} from "react";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import {Input} from "@/components/ui/input";
import {Button} from "@/components/ui/button";
import {Check, ChevronLeft, ChevronRight, Pencil, Search, X} from "lucide-react";

interface Column<T> {
    key: string;
    header: string;
    editable?: boolean;
    type?: "text" | "number" | "date";
    render?: (row: T, isEditing: boolean, index?: number) => React.ReactNode;
    className?: string;
    minWidth?: number;
    defaultWidth?: number;
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
}: DataTableProps<T>) {
    const [editingRow, setEditingRow] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Record<string, any>>({});
    const [searchQuery, setSearchQuery] = useState("");
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

    const filteredData = useMemo(() => {
        if (!searchQuery.trim()) return data;
        const q = searchQuery.toLowerCase();
        return data.filter((row) =>
            columns.some((col) => {
                const val = row[col.key];
                return val != null && String(val).toLowerCase().includes(q);
            })
        );
    }, [data, searchQuery, columns]);

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

    const hasEditableColumns = columns.some((c) => c.editable);
    const hasPagination = page !== undefined && totalItems !== undefined && onPageChange;
    const totalPages = hasPagination ? Math.max(1, Math.ceil(totalItems! / pageSize)) : 1;
    const currentPage = page ?? 0;

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
            <div className="px-6 pb-4">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search across all columns…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
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
            </div>
            <CardContent className="p-0">
                <div className="overflow-x-auto">
                    <Table style={{ tableLayout: "fixed" }}>
                        <TableHeader>
                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                                {columns.map((col) => {
                                    const width = columnWidths[col.key];
                                    return (
                                        <TableHead
                                            key={col.key}
                                            className={`font-semibold text-muted-foreground relative select-none ${col.className || ""}`}
                                            style={width ? { width: `${width}px` } : undefined}
                                        >
                                            <span className="pr-2">{col.header}</span>
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
                            {filteredData.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={columns.length + (hasEditableColumns ? 1 : 0)}
                                        className="text-center text-muted-foreground py-12"
                                    >
                                        {searchQuery ? "No results match your search." : emptyMessage}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredData.map((row, idx) => {
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

                {/* Pagination */}
                {hasPagination && totalItems! > 0 && (
                    <div className="flex items-center justify-between border-t px-6 py-3">
                        <p className="text-sm text-muted-foreground">
                            Showing {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, totalItems!)} of {totalItems!}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={totalPages <= 1}
                                onClick={() => {
                                    if (currentPage === 0) {
                                        onPageChange!(totalPages - 1);
                                    } else {
                                        onPageChange!(currentPage - 1);
                                    }
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
                                    if (currentPage >= totalPages - 1) {
                                        onPageChange!(0);
                                    } else {
                                        onPageChange!(currentPage + 1);
                                    }
                                }}
                            >
                                Next
                                <ChevronRight className="h-4 w-4 ml-1" />
                            </Button>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}