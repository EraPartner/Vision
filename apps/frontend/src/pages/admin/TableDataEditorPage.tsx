import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    ArrowLeft, Plus, Trash2, RotateCcw, Eye, AlertTriangle, ChevronUp, ChevronDown,
    ChevronsUpDown, ChevronLeft, ChevronRight, Ban, RefreshCw, Search, KeyRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import {
    getTableRows, previewTableMutation, commitTableMutation,
    type DbColumn, type DbRow, type DbChange, type DbFilter, type PreviewStatement,
} from '@/lib/api/dbEditor';

const PAGE_SIZE = 100;
const MATVIEW_BASE_TABLES = new Set(['transactions', 'recipients', 'categories']);

type SortState = { column: string; dir: 'asc' | 'desc' } | undefined;
type EditMap = Record<string, Record<string, unknown>>;
interface NewRow { tempId: string; values: Record<string, unknown> }

// ── value helpers ───────────────────────────────────────────────────────────

function rowKey(row: DbRow, primaryKey: string[]): string {
    return primaryKey.map((k) => String(row[k])).join('');
}

function pickPk(row: DbRow, primaryKey: string[]): Record<string, unknown> {
    const pk: Record<string, unknown> = {};
    for (const k of primaryKey) pk[k] = row[k];
    return pk;
}

function isBoolean(col: DbColumn): boolean {
    return col.udtName === 'bool' || col.dataType === 'boolean';
}

function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || a === undefined) return b === null || b === undefined;
    if (typeof a === 'object') return JSON.stringify(a) === (typeof b === 'object' ? JSON.stringify(b) : b);
    return String(a) === String(b);
}

function display(value: unknown): { text: string; isNull: boolean } {
    if (value === null || value === undefined) return { text: 'NULL', isNull: true };
    if (typeof value === 'object') return { text: JSON.stringify(value), isNull: false };
    if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
    return { text: String(value), isNull: false };
}

// ── editable cell ───────────────────────────────────────────────────────────

function EditableCell({
    column, value, dirty, disabled, lockEdit, onChange, t,
}: {
    column: DbColumn;
    value: unknown;
    dirty: boolean;
    disabled: boolean;
    lockEdit?: boolean;
    onChange: (next: unknown) => void;
    t: (k: string) => string;
}) {
    const [editing, setEditing] = useState(false);
    const dirtyCls = dirty ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-500/40' : '';
    // A column may be writable in the schema but locked for editing here (e.g.
    // primary keys on existing rows, which must not be repointed in place).
    const canEdit = column.writable && !disabled && !lockEdit;

    if (isBoolean(column)) {
        return (
            <TableCell className={dirtyCls}>
                <Checkbox
                    checked={value === true}
                    disabled={disabled || !column.writable || lockEdit}
                    onCheckedChange={(c) => onChange(c === true)}
                />
            </TableCell>
        );
    }

    if (editing && canEdit) {
        const shown = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        return (
            <TableCell className={dirtyCls}>
                <Input
                    autoFocus
                    defaultValue={shown}
                    className="h-7 font-mono text-xs"
                    onBlur={(e) => { onChange(e.target.value); setEditing(false); }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { onChange((e.target as HTMLInputElement).value); setEditing(false); }
                        if (e.key === 'Escape') setEditing(false);
                    }}
                />
            </TableCell>
        );
    }

    const { text, isNull } = display(value);
    return (
        <TableCell
            className={cn('font-mono text-xs', dirtyCls, canEdit && 'cursor-text')}
            onClick={() => canEdit && setEditing(true)}
            title={lockEdit ? t('dbEditor.readOnlyCol') : column.writable ? t('dbEditor.clickToEdit') : t('dbEditor.readOnlyCol')}
        >
            <div className="flex items-center justify-between gap-2 max-w-[28rem] truncate">
                <span className={cn('truncate', isNull && 'text-muted-foreground italic')}>{text}</span>
                {column.nullable && canEdit && !isNull && (
                    <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        title={t('dbEditor.setNull')}
                        onClick={(e) => { e.stopPropagation(); onChange(null); }}
                    >
                        <Ban className="h-3 w-3" />
                    </button>
                )}
            </div>
        </TableCell>
    );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function TableDataEditorPage() {
    const { table = '' } = useParams();
    const navigate = useNavigate();
    const qc = useQueryClient();
    const { t } = useLanguage();

    const [page, setPage] = useState(0);
    const [sort, setSort] = useState<SortState>(undefined);
    const [draftFilters, setDraftFilters] = useState<Record<string, string>>({});
    const [appliedFilters, setAppliedFilters] = useState<DbFilter[]>([]);

    const [edits, setEdits] = useState<EditMap>({});
    const [deletes, setDeletes] = useState<Set<string>>(new Set());
    const [newRows, setNewRows] = useState<NewRow[]>([]);
    const [tempSeq, setTempSeq] = useState(0);

    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewStatements, setPreviewStatements] = useState<PreviewStatement[]>([]);

    const query = useQuery({
        queryKey: ['admin', 'db-table', table, page, sort, appliedFilters],
        queryFn: () => getTableRows(table, {
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
            orderBy: sort?.column,
            dir: sort?.dir,
            filters: appliedFilters,
        }),
        placeholderData: (prev) => prev, // keep previous page while paging/sorting/filtering round-trips
    });

    const data = query.data;
    const columns = useMemo(() => data?.columns ?? [], [data]);
    const primaryKey = useMemo(() => data?.primaryKey ?? [], [data]);
    const rows = useMemo(() => data?.rows ?? [], [data]);
    const readOnly = !query.isLoading && primaryKey.length === 0;

    const rowsByKey = useMemo(() => {
        const m = new Map<string, DbRow>();
        for (const r of rows) m.set(rowKey(r, primaryKey), r);
        return m;
    }, [rows, primaryKey]);

    // Build the change list from pending state.
    const changes = useMemo<DbChange[]>(() => {
        const out: DbChange[] = [];
        for (const nr of newRows) out.push({ op: 'insert', values: nr.values });
        for (const [key, original] of rowsByKey) {
            if (deletes.has(key)) {
                out.push({ op: 'delete', pk: pickPk(original, primaryKey), xmin: original.__xmin });
                continue;
            }
            const edited = edits[key];
            if (!edited) continue;
            const set: Record<string, unknown> = {};
            for (const [col, val] of Object.entries(edited)) {
                if (!valuesEqual(original[col], val)) set[col] = val;
            }
            if (Object.keys(set).length) out.push({ op: 'update', pk: pickPk(original, primaryKey), xmin: original.__xmin, set });
        }
        return out;
    }, [newRows, rowsByKey, deletes, edits, primaryKey]);

    const pendingCount = changes.length;
    const hasPending = pendingCount > 0;

    // Per-op counts for the commit confirmation summary; deletes drive the
    // destructive styling on the commit button.
    const opCounts = useMemo(() => {
        let inserts = 0, updates = 0, deletes_ = 0;
        for (const c of changes) {
            if (c.op === 'insert') inserts += 1;
            else if (c.op === 'update') updates += 1;
            else deletes_ += 1;
        }
        return { inserts, updates, deletes: deletes_ };
    }, [changes]);
    const hasDeletes = opCounts.deletes > 0;

    function setCell(key: string, col: string, value: unknown) {
        setEdits((prev) => ({ ...prev, [key]: { ...prev[key], [col]: value } }));
    }
    function setNewCell(tempId: string, col: string, value: unknown) {
        setNewRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, values: { ...r.values, [col]: value } } : r)));
    }
    function toggleDelete(key: string) {
        setDeletes((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
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
            .filter(([, v]) => v.trim() !== '')
            .map(([column, v]) => ({ column, op: 'contains', value: v }));
        setAppliedFilters(fs);
        setPage(0);
    }
    function toggleSort(column: string) {
        setSort((prev) => {
            if (!prev || prev.column !== column) return { column, dir: 'asc' };
            if (prev.dir === 'asc') return { column, dir: 'desc' };
            return undefined;
        });
        setPage(0);
    }

    const previewMutation = useMutation({
        mutationFn: () => previewTableMutation(table, changes),
        onSuccess: (res) => { setPreviewStatements(res.statements); setPreviewOpen(true); },
        onError: (err: Error) => toast.error(t('dbEditor.previewFailed'), { description: err.message }),
    });

    const commitMutation = useMutation({
        mutationFn: () => commitTableMutation(table, changes),
        onSuccess: (res) => {
            toast.success(t('dbEditor.commitSuccess'), { description: `${res.applied} ${t('dbEditor.statementsApplied')}` });
            setPreviewOpen(false);
            discardAll();
            qc.invalidateQueries({ queryKey: ['admin', 'db-table', table] });
        },
        onError: (err: Error) => toast.error(t('dbEditor.commitFailed'), { description: err.message }),
    });

    const total = data?.total ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="space-y-4">
            <PageHeader
                title={table}
                subtitle={t('dbEditor.subtitle')}
                actions={
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => navigate('/admin/db')}>
                            <ArrowLeft className="h-4 w-4" />
                            {t('dbEditor.back')}
                        </Button>
                        <Button variant="outline" size="sm" className="gap-2" disabled={query.isFetching}
                            onClick={() => qc.invalidateQueries({ queryKey: ['admin', 'db-table', table] })}>
                            <RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />
                            {t('dbEditor.refresh')}
                        </Button>
                    </div>
                }
            />

            {/* Caution banner */}
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                    {t('dbEditor.warning')}
                    {MATVIEW_BASE_TABLES.has(table) ? ` ${t('dbEditor.warningMatview')}` : ''}
                </span>
            </div>

            {/* Toolbar. Filtering is the per-column inputs in the header row
                (structured, parameterized). The raw-WHERE box was removed —
                it was a SQL-injection oracle (ADR-101 addendum, 2026-07-10). */}
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={applyFilters} disabled={hasPending}>
                    {t('dbEditor.applyFilters')}
                </Button>
                <div className="flex-1" />
                <Button variant="outline" size="sm" className="gap-2" onClick={addRow} disabled={readOnly}>
                    <Plus className="h-4 w-4" />
                    {t('dbEditor.addRow')}
                </Button>
                {hasPending && (
                    <>
                        <span className="text-xs text-muted-foreground">
                            {t('dbEditor.pending', { n: pendingCount })}
                        </span>
                        <Button variant="ghost" size="sm" className="gap-2" onClick={discardAll}>
                            <RotateCcw className="h-4 w-4" />
                            {t('dbEditor.discard')}
                        </Button>
                        <Button size="sm" className="gap-2" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
                            <Eye className="h-4 w-4" />
                            {t('dbEditor.preview')}
                        </Button>
                    </>
                )}
            </div>

            {hasPending && (
                <p className="text-xs text-muted-foreground">{t('dbEditor.lockedWhilePending')}</p>
            )}

            {query.error && (
                <Card className="!border-destructive/60 bg-destructive/5">
                    <CardContent className="pt-6">
                        <p className="text-sm text-destructive">{t('dbEditor.loadError')}: {(query.error as Error).message}</p>
                    </CardContent>
                </Card>
            )}

            {/* Grid */}
            <Card className="glass-chrome overflow-hidden">
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader className="bg-foreground/[0.015]">
                            {/* Column titles + sort */}
                            <TableRow className="!border-b-0 hover:bg-transparent">
                                <TableHead className="h-9 w-10" />
                                {columns.map((col) => {
                                    const active = sort?.column === col.name;
                                    const isPk = primaryKey.includes(col.name);
                                    return (
                                        <TableHead key={col.name} className="h-9 whitespace-nowrap pb-0 pt-2.5">
                                            <button
                                                type="button"
                                                className="group/sort -mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs lowercase tracking-normal text-foreground/75 transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:pointer-events-none disabled:opacity-100"
                                                onClick={() => toggleSort(col.name)}
                                                disabled={hasPending}
                                            >
                                                {isPk && <KeyRound className="h-3 w-3 shrink-0 text-amber-500" aria-label="PK" />}
                                                <span>{col.name}</span>
                                                {active
                                                    ? (sort!.dir === 'asc'
                                                        ? <ChevronUp className="h-3 w-3 shrink-0 text-primary" />
                                                        : <ChevronDown className="h-3 w-3 shrink-0 text-primary" />)
                                                    : <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover/sort:text-muted-foreground/50" />}
                                            </button>
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                            {/* Per-column filters */}
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="h-10 w-10" />
                                {columns.map((col) => (
                                    <TableHead key={col.name} className="h-10 pb-2.5 pt-0">
                                        <div className="relative min-w-[7rem]">
                                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
                                            <Input
                                                value={draftFilters[col.name] ?? ''}
                                                placeholder={t('dbEditor.filterPlaceholder')}
                                                className="h-7 rounded-md border-border/40 bg-background/40 pl-7 pr-2 font-mono text-[11px] shadow-none placeholder:text-muted-foreground/40 focus-visible:bg-background/80 focus-visible:ring-offset-0"
                                                onChange={(e) => setDraftFilters((p) => ({ ...p, [col.name]: e.target.value }))}
                                                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
                                                disabled={hasPending}
                                            />
                                        </div>
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.isLoading && Array.from({ length: 8 }).map((_, i) => (
                                <TableRow key={i}>
                                    <TableCell colSpan={(columns.length || 1) + 1}><Skeleton className="h-4 w-full" /></TableCell>
                                </TableRow>
                            ))}

                            {/* New (insert) rows */}
                            {newRows.map((nr) => (
                                <TableRow key={nr.tempId} className="bg-emerald-500/5">
                                    <TableCell className="w-10">
                                        <Button variant="ghost" size="icon" className="h-6 w-6"
                                            onClick={() => setNewRows((prev) => prev.filter((r) => r.tempId !== nr.tempId))}>
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    </TableCell>
                                    {columns.map((col) => (
                                        <EditableCell
                                            key={col.name}
                                            column={col}
                                            value={nr.values[col.name] ?? null}
                                            dirty={col.name in nr.values}
                                            disabled={false}
                                            onChange={(v) => setNewCell(nr.tempId, col.name, v)}
                                            t={t}
                                        />
                                    ))}
                                </TableRow>
                            ))}

                            {/* Existing rows */}
                            {!query.isLoading && rows.map((row) => {
                                const key = rowKey(row, primaryKey);
                                const isDeleted = deletes.has(key);
                                const edited = edits[key] ?? {};
                                return (
                                    <TableRow key={key} className={isDeleted ? 'bg-destructive/5 line-through opacity-60' : ''}>
                                        <TableCell className="w-10">
                                            <Button variant="ghost" size="icon" className="h-6 w-6" disabled={readOnly}
                                                title={isDeleted ? t('dbEditor.undoDelete') : t('dbEditor.deleteRow')}
                                                onClick={() => toggleDelete(key)}>
                                                {isDeleted ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                                            </Button>
                                        </TableCell>
                                        {columns.map((col) => {
                                            const hasEdit = col.name in edited;
                                            const value = hasEdit ? edited[col.name] : row[col.name];
                                            return (
                                                <EditableCell
                                                    key={col.name}
                                                    column={col}
                                                    value={value}
                                                    dirty={hasEdit && !valuesEqual(row[col.name], value)}
                                                    disabled={isDeleted}
                                                    // Primary keys identify the row in the UPDATE/DELETE WHERE
                                                    // clause; editing them in place would silently retarget a
                                                    // different row. Lock them on existing rows.
                                                    lockEdit={primaryKey.includes(col.name)}
                                                    onChange={(v) => setCell(key, col.name, v)}
                                                    t={t}
                                                />
                                            );
                                        })}
                                    </TableRow>
                                );
                            })}

                            {!query.isLoading && rows.length === 0 && newRows.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={(columns.length || 1) + 1} className="h-24 text-center text-muted-foreground">
                                        {t('dbEditor.empty')}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>

                {/* Pagination footer */}
                <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
                    <span>{t('dbEditor.rowsCount', { n: total })}</span>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 0 || hasPending}
                            onClick={() => setPage((p) => Math.max(0, p - 1))}>
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <span>{t('dbEditor.pageOf', { page: page + 1, pages: pageCount })}</span>
                        <Button variant="outline" size="icon" className="h-7 w-7" disabled={page + 1 >= pageCount || hasPending}
                            onClick={() => setPage((p) => p + 1)}>
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </Card>

            {/* Preview / commit dialog */}
            <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>{t('dbEditor.previewTitle')}</DialogTitle>
                        <DialogDescription>{t('dbEditor.previewDescription')}</DialogDescription>
                    </DialogHeader>
                    {/* Operation summary so the user confirms exactly what will run. */}
                    <p className="text-sm font-medium">
                        {t('dbEditor.commitSummary', { inserts: opCounts.inserts, updates: opCounts.updates, deletes: opCounts.deletes })}
                    </p>
                    {hasDeletes && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{t('dbEditor.deleteWarning')}</span>
                        </div>
                    )}
                    <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-md bg-muted/40 p-3">
                        {previewStatements.map((s, i) => (
                            <pre key={i} className="whitespace-pre-wrap break-all font-mono text-xs">
                                <span className="mr-2 uppercase text-muted-foreground">{s.op}</span>{s.preview};
                            </pre>
                        ))}
                        {previewStatements.length === 0 && (
                            <p className="text-sm text-muted-foreground">{t('dbEditor.previewEmpty')}</p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPreviewOpen(false)}>{t('dbEditor.cancel')}</Button>
                        <Button
                            variant={hasDeletes ? 'destructive' : 'default'}
                            onClick={() => commitMutation.mutate()}
                            disabled={commitMutation.isPending || previewStatements.length === 0}
                        >
                            {commitMutation.isPending ? t('dbEditor.committing') : t('dbEditor.commit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
