import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router";
import {
    ArrowLeft,
    Plus,
    Trash2,
    RotateCcw,
    Eye,
    AlertTriangle,
    ChevronUp,
    ChevronDown,
    ChevronsUpDown,
    ChevronLeft,
    ChevronRight,
    Ban,
    RefreshCw,
    Search,
    KeyRound,
    MoreHorizontal,
    Table2,
} from "lucide-react";

import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdminErrorState } from "@/components/shared/AdminErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import {
    type DbColumn,
    type DbRow,
    type DbChange,
    type DbFilter,
    type PreviewStatement,
} from "@/lib/api/dbEditor";
import {
    useTableMutationData,
    useTableRows,
} from "@/features/admin/useTableDataEditorData";

const MATVIEW_BASE_TABLES = new Set([
    "transactions",
    "recipients",
    "categories",
]);

type SortState = { column: string; dir: "asc" | "desc" } | undefined;
type EditMap = Record<string, Record<string, unknown>>;
interface NewRow {
    tempId: string;
    values: Record<string, unknown>;
}

// ── value helpers ───────────────────────────────────────────────────────────

function rowKey(
    row: DbRow,
    primaryKey: string[],
    readOnlyIndex?: number,
): string {
    if (primaryKey.length > 0) {
        return primaryKey.map((k) => String(row[k])).join("");
    }
    return `readonly:${readOnlyIndex}:${JSON.stringify(row)}`;
}

function pickPk(row: DbRow, primaryKey: string[]): Record<string, unknown> {
    const pk: Record<string, unknown> = {};
    for (const k of primaryKey) pk[k] = row[k];
    return pk;
}

function isBoolean(col: DbColumn): boolean {
    return col.udtName === "bool" || col.dataType === "boolean";
}

function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || a === undefined) return b === null || b === undefined;
    if (typeof a === "object")
        return (
            JSON.stringify(a) ===
            (typeof b === "object" ? JSON.stringify(b) : b)
        );
    return String(a) === String(b);
}

function display(value: unknown): { text: string; isNull: boolean } {
    if (value === null || value === undefined)
        return { text: "NULL", isNull: true };
    if (typeof value === "object")
        return { text: JSON.stringify(value), isNull: false };
    if (typeof value === "boolean")
        return { text: value ? "true" : "false", isNull: false };
    return { text: String(value), isNull: false };
}

// ── editable cell ───────────────────────────────────────────────────────────

const CELL_ACTION_CLASS =
    "h-5 w-5 shrink-0 rounded-chip [&_svg]:size-3";

function RevertCellButton({
    onRevert,
    t,
}: {
    onRevert: () => void;
    t: (k: string) => string;
}) {
    const label = t("dbEditor.revertCell");
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(CELL_ACTION_CLASS, "text-warning hover:text-foreground")}
            aria-label={label}
            title={label}
            onClick={(e) => {
                e.stopPropagation();
                onRevert();
            }}
        >
            <RotateCcw aria-hidden="true" />
        </Button>
    );
}

function EditableCell({
    column,
    label,
    value,
    dirty,
    disabled,
    lockEdit,
    onChange,
    onRevert,
    t,
}: {
    column: DbColumn;
    label: string;
    value: unknown;
    dirty: boolean;
    disabled: boolean;
    lockEdit?: boolean;
    onChange: (next: unknown) => void;
    onRevert: () => void;
    t: (k: string) => string;
}) {
    const [editing, setEditing] = useState(false);
    const cellRef = useRef<HTMLTableCellElement>(null);
    const restoreFocus = useRef(false);
    useEffect(() => {
        if (!editing && restoreFocus.current) {
            restoreFocus.current = false;
            cellRef.current?.focus();
        }
    }, [editing]);
    const dirtyCls = dirty
        ? "bg-warning/10 shadow-[inset_0_0_0_1px_hsl(var(--warning)/0.4)]"
        : "";
    // A column may be writable in the schema but locked for editing here (e.g.
    // primary keys on existing rows, which must not be repointed in place).
    const canEdit = column.writable && !disabled && !lockEdit;

    if (isBoolean(column)) {
        return (
            <TableCell className={cn("py-2", dirtyCls)}>
                <div className="flex items-center gap-2">
                    <Checkbox
                        aria-label={label}
                        checked={value === true}
                        disabled={disabled || !column.writable || lockEdit}
                        aria-keyshortcuts="Escape"
                        onCheckedChange={(c) => onChange(c === true)}
                        onKeyDown={(e) => {
                            if (e.key !== "Escape" || !dirty) return;
                            e.preventDefault();
                            onRevert();
                        }}
                    />
                    {dirty && canEdit && (
                        <RevertCellButton onRevert={onRevert} t={t} />
                    )}
                </div>
            </TableCell>
        );
    }

    if (editing && canEdit) {
        const shown =
            value === null || value === undefined
                ? ""
                : typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value);
        return (
            <TableCell className={cn("py-1.5", dirtyCls)}>
                <Input
                    autoFocus
                    aria-label={label}
                    defaultValue={shown}
                    aria-keyshortcuts="Enter Escape"
                    className="h-8 font-mono type-footnote"
                    onBlur={(e) => {
                        onChange(e.target.value);
                        setEditing(false);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            restoreFocus.current = true;
                            onChange((e.target as HTMLInputElement).value);
                            setEditing(false);
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            restoreFocus.current = true;
                            onRevert();
                            setEditing(false);
                        }
                    }}
                />
            </TableCell>
        );
    }

    const { text, isNull } = display(value);
    return (
        <TableCell
            ref={cellRef}
            tabIndex={canEdit ? 0 : undefined}
            aria-label={label}
            aria-keyshortcuts={canEdit ? "Enter Space" : undefined}
            onKeyDown={(event) => {
                if (!canEdit || event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setEditing(true);
                }
            }}
            className={cn(
                "py-2 font-mono type-footnote",
                dirtyCls,
                canEdit && "cursor-text focus-ring focus-visible:outline-offset-[-3px]",
            )}
            onClick={() => canEdit && setEditing(true)}
            title={
                lockEdit
                    ? t("dbEditor.readOnlyCol")
                    : column.writable
                      ? t("dbEditor.clickToEdit")
                      : t("dbEditor.readOnlyCol")
            }
        >
            <div className="flex max-w-[28rem] items-center justify-between gap-2 truncate">
                <span
                    className={cn(
                        "truncate",
                        isNull && "italic text-label-tertiary",
                    )}
                >
                    {text}
                </span>
                {dirty && canEdit && (
                    <RevertCellButton onRevert={onRevert} t={t} />
                )}
                {column.nullable && canEdit && !isNull && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                            CELL_ACTION_CLASS,
                            "text-label-tertiary hover:text-foreground",
                        )}
                        title={t("dbEditor.setNull")}
                        aria-label={t("dbEditor.setNull")}
                        onClick={(e) => {
                            e.stopPropagation();
                            onChange(null);
                        }}
                    >
                        <Ban aria-hidden="true" />
                    </Button>
                )}
            </div>
        </TableCell>
    );
}

// ── row menu ────────────────────────────────────────────────────────────────

function RowMenuTrigger({ label }: { label: string }) {
    return (
        <DropdownMenuTrigger asChild>
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={label}
            >
                <MoreHorizontal aria-hidden="true" />
            </Button>
        </DropdownMenuTrigger>
    );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function TableDataEditorPage() {
    const { table = "" } = useParams();
    const navigate = useNavigate();
    const { t, tc } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();

    const [page, setPage] = useState(0);
    const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
    const [sort, setSort] = useState<SortState>(undefined);
    const [draftFilters, setDraftFilters] = useState<Record<string, string>>(
        {},
    );
    const [appliedFilters, setAppliedFilters] = useState<DbFilter[]>([]);

    const [edits, setEdits] = useState<EditMap>({});
    const [deletes, setDeletes] = useState<Set<string>>(new Set());
    const [newRows, setNewRows] = useState<NewRow[]>([]);
    const [tempSeq, setTempSeq] = useState(0);

    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewStatements, setPreviewStatements] = useState<
        PreviewStatement[]
    >([]);

    const { query, refresh } = useTableRows(
        table,
        pageCursors[page] ?? null,
        sort,
        appliedFilters,
    );

    const data = query.data;
    const columns = useMemo(() => data?.columns ?? [], [data]);
    const primaryKey = useMemo(() => data?.primaryKey ?? [], [data]);
    const rows = useMemo(() => data?.rows ?? [], [data]);
    const readOnly = query.isLoading || primaryKey.length === 0;

    const rowsByKey = useMemo(() => {
        const m = new Map<string, DbRow>();
        if (primaryKey.length === 0) return m;
        for (const r of rows) m.set(rowKey(r, primaryKey), r);
        return m;
    }, [rows, primaryKey]);

    // Build the change list from pending state.
    const changes = useMemo<DbChange[]>(() => {
        const out: DbChange[] = [];
        for (const nr of newRows) out.push({ op: "insert", values: nr.values });
        for (const [key, original] of rowsByKey) {
            if (deletes.has(key)) {
                out.push({
                    op: "delete",
                    pk: pickPk(original, primaryKey),
                    xmin: original.__xmin,
                });
                continue;
            }
            const edited = edits[key];
            if (!edited) continue;
            const set: Record<string, unknown> = {};
            for (const [col, val] of Object.entries(edited)) {
                if (!valuesEqual(original[col], val)) set[col] = val;
            }
            if (Object.keys(set).length)
                out.push({
                    op: "update",
                    pk: pickPk(original, primaryKey),
                    xmin: original.__xmin,
                    set,
                });
        }
        return out;
    }, [newRows, rowsByKey, deletes, edits, primaryKey]);

    const pendingCount = changes.length;
    const hasPending = pendingCount > 0;
    useUnsavedChanges(hasPending);

    // Per-op counts for the commit confirmation summary; deletes drive the
    // destructive styling on the commit button.
    const opCounts = useMemo(() => {
        let inserts = 0,
            updates = 0,
            deletes_ = 0;
        for (const c of changes) {
            if (c.op === "insert") inserts += 1;
            else if (c.op === "update") updates += 1;
            else deletes_ += 1;
        }
        return { inserts, updates, deletes: deletes_ };
    }, [changes]);
    const hasDeletes = opCounts.deletes > 0;

    function setCell(key: string, col: string, value: unknown) {
        setEdits((prev) => ({
            ...prev,
            [key]: { ...prev[key], [col]: value },
        }));
    }
    function revertCell(key: string, col: string) {
        setEdits((prev) => {
            const rowEdits = prev[key];
            if (!rowEdits || !(col in rowEdits)) return prev;
            const nextRowEdits = { ...rowEdits };
            delete nextRowEdits[col];
            if (Object.keys(nextRowEdits).length > 0) {
                return { ...prev, [key]: nextRowEdits };
            }
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }
    function revertRow(key: string) {
        setEdits((prev) => {
            if (!(key in prev)) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }
    function setNewCell(tempId: string, col: string, value: unknown) {
        setNewRows((prev) =>
            prev.map((r) =>
                r.tempId === tempId
                    ? { ...r, values: { ...r.values, [col]: value } }
                    : r,
            ),
        );
    }
    function revertNewCell(tempId: string, col: string) {
        setNewRows((prev) =>
            prev.map((row) => {
                if (row.tempId !== tempId || !(col in row.values)) return row;
                const values = { ...row.values };
                delete values[col];
                return { ...row, values };
            }),
        );
    }
    function toggleDelete(key: string) {
        setDeletes((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }
    function addRow() {
        const id = `new-${tempSeq}`;
        setTempSeq((n) => n + 1);
        setNewRows((prev) => [...prev, { tempId: id, values: {} }]);
    }
    function discardAll() {
        setEdits({});
        setDeletes(new Set());
        setNewRows([]);
    }
    function applyFilters() {
        const fs: DbFilter[] = Object.entries(draftFilters)
            .filter(([, v]) => v.trim() !== "")
            .map(([column, v]) => ({ column, op: "contains", value: v }));
        setAppliedFilters(fs);
        setPage(0);
        setPageCursors([null]);
    }
    function toggleSort(column: string) {
        setSort((prev) => {
            if (!prev || prev.column !== column) return { column, dir: "asc" };
            if (prev.dir === "asc") return { column, dir: "desc" };
            return undefined;
        });
        setPage(0);
        setPageCursors([null]);
    }

    const { preview: previewMutation, commit: commitMutation } =
        useTableMutationData(table);

    const rowMenuLabel = t("dbEditor.rowMenu");

    return (
        <PageShell>
            <PageHeader
                title={table}
                subtitle={t("dbEditor.subtitle")}
                actions={
                    <>
                        <Button
                            variant="outline"
                            onClick={() => navigate("/admin/db")}
                        >
                            <ArrowLeft aria-hidden="true" />
                            {t("dbEditor.back")}
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    aria-label={t("admin.moreActions")}
                                >
                                    <MoreHorizontal aria-hidden="true" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    disabled={query.isFetching}
                                    onSelect={refresh}
                                >
                                    <RefreshCw
                                        aria-hidden="true"
                                        className={cn(
                                            "mr-2 h-4 w-4 text-label-secondary",
                                            query.isFetching && "animate-spin",
                                        )}
                                    />
                                    {t("dbEditor.refresh")}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button onClick={addRow} disabled={readOnly}>
                            <Plus aria-hidden="true" />
                            {t("dbEditor.addRow")}
                        </Button>
                    </>
                }
            />

            <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                    {t("dbEditor.warning")}
                    {MATVIEW_BASE_TABLES.has(table)
                        ? ` ${t("dbEditor.warningMatview")}`
                        : ""}
                </AlertDescription>
            </Alert>

            {/* Toolbar. Filtering is the per-column inputs in the header row
                (structured, parameterized). The raw-WHERE box was removed —
                it was a SQL-injection oracle (ADR-101 addendum, 2026-07-10). */}
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    onClick={applyFilters}
                    disabled={hasPending}
                >
                    <Search aria-hidden="true" />
                    {t("dbEditor.applyFilters")}
                </Button>
                {hasPending && (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <span
                            role="status"
                            className="type-callout font-medium text-foreground"
                        >
                            {tc("dbEditor.pendingCount", pendingCount)}
                        </span>
                        <Button variant="ghost" onClick={discardAll}>
                            <RotateCcw aria-hidden="true" />
                            {t("dbEditor.discard")}
                        </Button>
                        <Button
                            onClick={() =>
                                previewMutation.mutate(changes, {
                                    onSuccess: (res) => {
                                        setPreviewStatements(res.statements);
                                        setPreviewOpen(true);
                                    },
                                })
                            }
                            disabled={previewMutation.isPending}
                        >
                            <Eye aria-hidden="true" />
                            {t("dbEditor.preview")}
                        </Button>
                    </div>
                )}
            </div>

            {hasPending && (
                <p className="type-footnote text-label-secondary">
                    {t("dbEditor.lockedWhilePending")}
                </p>
            )}

            {query.error && (
                <AdminErrorState
                    error={query.error}
                    fallbackMessage={t("dbEditor.loadError")}
                />
            )}

            {/* Grid */}
            <Card className="overflow-hidden">
                {/* The skeleton rows live inside <tbody>, where a wrapper
                    element would be invalid HTML — the scroll container around
                    the table carries the status role, only while loading. */}
                <div
                    {...(query.isLoading ? loadingSurfaceProps : {})}
                    className="overflow-x-auto"
                >
                    <Table>
                        <TableHeader className="bg-foreground/[0.015]">
                            {/* Column titles + sort */}
                            <TableRow className="!border-b-0 hover:bg-transparent">
                                <TableHead className="h-9 w-10" />
                                {columns.map((col) => {
                                    const active = sort?.column === col.name;
                                    const isPk = primaryKey.includes(col.name);
                                    return (
                                        <TableHead
                                            key={col.name}
                                            className="h-9 whitespace-nowrap pb-0 pt-2"
                                        >
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                className="group/sort -mx-2 h-7 gap-1.5 px-2 font-mono type-footnote font-normal text-label-secondary hover:text-foreground disabled:opacity-100 [&_svg]:size-3"
                                                onClick={() =>
                                                    toggleSort(col.name)
                                                }
                                                disabled={hasPending}
                                            >
                                                {isPk && (
                                                    <KeyRound
                                                        className="text-warning"
                                                        aria-label="PK"
                                                    />
                                                )}
                                                <span>{col.name}</span>
                                                {active ? (
                                                    sort!.dir === "asc" ? (
                                                        <ChevronUp
                                                            aria-hidden="true"
                                                            className="text-primary"
                                                        />
                                                    ) : (
                                                        <ChevronDown
                                                            aria-hidden="true"
                                                            className="text-primary"
                                                        />
                                                    )
                                                ) : (
                                                    <ChevronsUpDown
                                                        aria-hidden="true"
                                                        className="text-label-tertiary opacity-0 transition-opacity duration-fast group-hover/sort:opacity-100"
                                                    />
                                                )}
                                            </Button>
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                            {/* Per-column filters */}
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="h-11 w-10" />
                                {columns.map((col) => (
                                    <TableHead
                                        key={col.name}
                                        className="h-11 pb-2.5 pt-0"
                                    >
                                        <div className="relative min-w-[7rem]">
                                            <Search
                                                aria-hidden="true"
                                                className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-label-tertiary"
                                            />
                                            <Input
                                                value={
                                                    draftFilters[col.name] ?? ""
                                                }
                                                placeholder={t(
                                                    "dbEditor.filterPlaceholder",
                                                )}
                                                aria-label={`${t("dbEditor.filterPlaceholder")} ${col.name}`}
                                                className="h-8 pl-7 pr-2 font-mono type-footnote"
                                                onChange={(e) =>
                                                    setDraftFilters((p) => ({
                                                        ...p,
                                                        [col.name]:
                                                            e.target.value,
                                                    }))
                                                }
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter")
                                                        applyFilters();
                                                }}
                                                disabled={hasPending}
                                            />
                                        </div>
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.isLoading &&
                                Array.from({ length: 8 }).map((_, i) => (
                                    <TableRow key={i}>
                                        <TableCell
                                            colSpan={(columns.length || 1) + 1}
                                        >
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                    </TableRow>
                                ))}

                            {/* New (insert) rows */}
                            {newRows.map((nr, rowIndex) => (
                                <TableRow
                                    key={nr.tempId}
                                    className="bg-success/5"
                                >
                                    <TableCell className="w-10 py-1.5">
                                        <DropdownMenu>
                                            <RowMenuTrigger
                                                label={rowMenuLabel}
                                            />
                                            <DropdownMenuContent align="start">
                                                <DropdownMenuItem
                                                    className="text-destructive focus:text-destructive"
                                                    onSelect={() =>
                                                        setNewRows((prev) =>
                                                            prev.filter(
                                                                (r) =>
                                                                    r.tempId !==
                                                                    nr.tempId,
                                                            ),
                                                        )
                                                    }
                                                >
                                                    <Trash2
                                                        aria-hidden="true"
                                                        className="mr-2 h-4 w-4"
                                                    />
                                                    {t(
                                                        "dbEditor.discardNewRow",
                                                    )}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </TableCell>
                                    {columns.map((col) => (
                                        <EditableCell
                                            key={col.name}
                                            column={col}
                                            label={t("dbEditor.cellLabel", {
                                                column: col.name,
                                                row: `${t("dbEditor.addRow")} ${rowIndex + 1}`,
                                            })}
                                            value={nr.values[col.name] ?? null}
                                            dirty={col.name in nr.values}
                                            disabled={false}
                                            onChange={(v) =>
                                                setNewCell(
                                                    nr.tempId,
                                                    col.name,
                                                    v,
                                                )
                                            }
                                            onRevert={() =>
                                                revertNewCell(
                                                    nr.tempId,
                                                    col.name,
                                                )
                                            }
                                            t={t}
                                        />
                                    ))}
                                </TableRow>
                            ))}

                            {/* Existing rows */}
                            {!query.isLoading &&
                                rows.map((row, rowIndex) => {
                                    const key = rowKey(
                                        row,
                                        primaryKey,
                                        rowIndex,
                                    );
                                    const isDeleted = deletes.has(key);
                                    const edited = edits[key] ?? {};
                                    const hasRowEdits =
                                        Object.keys(edited).length > 0;
                                    return (
                                        <TableRow
                                            key={key}
                                            className={
                                                isDeleted
                                                    ? "bg-destructive/5 line-through opacity-60"
                                                    : ""
                                            }
                                        >
                                            <TableCell className="w-10 py-1.5">
                                                <DropdownMenu>
                                                    <RowMenuTrigger
                                                        label={rowMenuLabel}
                                                    />
                                                    <DropdownMenuContent align="start">
                                                        <DropdownMenuItem
                                                            disabled={
                                                                readOnly ||
                                                                !hasRowEdits ||
                                                                isDeleted
                                                            }
                                                            onSelect={() =>
                                                                revertRow(key)
                                                            }
                                                        >
                                                            <RotateCcw
                                                                aria-hidden="true"
                                                                className="mr-2 h-4 w-4 text-label-secondary"
                                                            />
                                                            {t(
                                                                "dbEditor.revertRow",
                                                            )}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuSeparator />
                                                        {isDeleted ? (
                                                            <DropdownMenuItem
                                                                disabled={
                                                                    readOnly
                                                                }
                                                                onSelect={() =>
                                                                    toggleDelete(
                                                                        key,
                                                                    )
                                                                }
                                                            >
                                                                <RotateCcw
                                                                    aria-hidden="true"
                                                                    className="mr-2 h-4 w-4 text-label-secondary"
                                                                />
                                                                {t(
                                                                    "dbEditor.undoDelete",
                                                                )}
                                                            </DropdownMenuItem>
                                                        ) : (
                                                            <DropdownMenuItem
                                                                disabled={
                                                                    readOnly
                                                                }
                                                                className="text-destructive focus:text-destructive"
                                                                onSelect={() =>
                                                                    toggleDelete(
                                                                        key,
                                                                    )
                                                                }
                                                            >
                                                                <Trash2
                                                                    aria-hidden="true"
                                                                    className="mr-2 h-4 w-4"
                                                                />
                                                                {t(
                                                                    "dbEditor.deleteRow",
                                                                )}
                                                            </DropdownMenuItem>
                                                        )}
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </TableCell>
                                            {columns.map((col) => {
                                                const hasEdit =
                                                    col.name in edited;
                                                const value = hasEdit
                                                    ? edited[col.name]
                                                    : row[col.name];
                                                return (
                                                    <EditableCell
                                                        key={col.name}
                                                        column={col}
                                                        label={t(
                                                            "dbEditor.cellLabel",
                                                            {
                                                                column: col.name,
                                                                row: primaryKey.length
                                                                    ? primaryKey
                                                                          .map(
                                                                              (
                                                                                  name,
                                                                              ) =>
                                                                                  `${name}=${String(row[name])}`,
                                                                          )
                                                                          .join(
                                                                              ", ",
                                                                          )
                                                                    : String(
                                                                          rowIndex +
                                                                              1,
                                                                      ),
                                                            },
                                                        )}
                                                        value={value}
                                                        dirty={
                                                            hasEdit &&
                                                            !valuesEqual(
                                                                row[col.name],
                                                                value,
                                                            )
                                                        }
                                                        disabled={isDeleted}
                                                        // Primary keys identify the row in the UPDATE/DELETE WHERE
                                                        // clause; editing them in place would silently retarget a
                                                        // different row. Lock them on existing rows.
                                                        lockEdit={primaryKey.includes(
                                                            col.name,
                                                        )}
                                                        onChange={(v) =>
                                                            setCell(
                                                                key,
                                                                col.name,
                                                                v,
                                                            )
                                                        }
                                                        onRevert={() =>
                                                            revertCell(
                                                                key,
                                                                col.name,
                                                            )
                                                        }
                                                        t={t}
                                                    />
                                                );
                                            })}
                                        </TableRow>
                                    );
                                })}

                            {!query.isLoading &&
                                rows.length === 0 &&
                                newRows.length === 0 && (
                                    <TableRow className="hover:bg-transparent">
                                        <TableCell
                                            colSpan={(columns.length || 1) + 1}
                                        >
                                            <EmptyState
                                                size="compact"
                                                headingLevel={3}
                                                icon={Table2}
                                                title={t("dbEditor.empty")}
                                            />
                                        </TableCell>
                                    </TableRow>
                                )}
                        </TableBody>
                    </Table>
                </div>

                {/* Pagination footer */}
                <div className="flex items-center justify-between gap-2 border-t border-border/50 px-4 py-2 type-footnote text-label-secondary">
                    <span>{tc("dbEditor.rowsOnPage", rows.length)}</span>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            disabled={
                                page <= 0 || hasPending || query.isFetching
                            }
                            aria-label={t("dbEditor.prevPage")}
                            onClick={() => setPage((p) => Math.max(0, p - 1))}
                        >
                            <ChevronLeft aria-hidden="true" />
                        </Button>
                        <span className="tabular-nums">
                            {t("dbEditor.pageNumber", {
                                page: page + 1,
                            })}
                        </span>
                        <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            disabled={
                                !data?.hasMore || hasPending || query.isFetching
                            }
                            aria-label={t("dbEditor.nextPage")}
                            onClick={() => {
                                if (!data?.nextCursor) return;
                                setPageCursors((current) => [
                                    ...current.slice(0, page + 1),
                                    data.nextCursor,
                                ]);
                                setPage((p) => p + 1);
                            }}
                        >
                            <ChevronRight aria-hidden="true" />
                        </Button>
                    </div>
                </div>
            </Card>

            {/* Preview / commit dialog */}
            <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>{t("dbEditor.previewTitle")}</DialogTitle>
                        <DialogDescription>
                            {t("dbEditor.previewDescription")}
                        </DialogDescription>
                    </DialogHeader>
                    {/* Operation summary so the user confirms exactly what will run. */}
                    <p className="type-body font-medium text-foreground">
                        {t("dbEditor.commitSummary", {
                            inserts: opCounts.inserts,
                            updates: opCounts.updates,
                            deletes: opCounts.deletes,
                        })}
                    </p>
                    {hasDeletes && (
                        <Alert variant="destructive">
                            <AlertTriangle
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            <AlertDescription>
                                {t("dbEditor.deleteWarning")}
                            </AlertDescription>
                        </Alert>
                    )}
                    <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-card corner-continuous bg-foreground/[0.04] p-3">
                        {previewStatements.map((s, i) => (
                            <pre
                                key={i}
                                className="whitespace-pre-wrap break-all font-mono type-footnote text-foreground"
                            >
                                <span className="mr-2 type-caption font-medium text-label-secondary">
                                    {s.op}
                                </span>
                                {s.preview};
                            </pre>
                        ))}
                        {previewStatements.length === 0 && (
                            <p className="type-body text-label-secondary">
                                {t("dbEditor.previewEmpty")}
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setPreviewOpen(false)}
                        >
                            {t("dbEditor.cancel")}
                        </Button>
                        <Button
                            variant={hasDeletes ? "destructive" : "default"}
                            onClick={() =>
                                commitMutation.mutate(changes, {
                                    onSuccess: () => {
                                        setPreviewOpen(false);
                                        discardAll();
                                    },
                                })
                            }
                            disabled={
                                commitMutation.isPending ||
                                previewStatements.length === 0
                            }
                        >
                            {commitMutation.isPending
                                ? t("dbEditor.committing")
                                : t("dbEditor.commit")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}
