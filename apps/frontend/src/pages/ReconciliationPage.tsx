import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle, GitCompare, Plus, Trash2, Unlink, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { formatCurrency, numberFormatToLocale } from '@/utils/currency';
import {
    listStatements,
    createStatement,
    deleteStatement,
    listEntries,
    setMatch,
    clearMatch,
    getMatchCandidates,
} from '@/lib/api/reconciliation';
import type {
    BankStatement,
    BankStatementCreate,
    ReconciliationEntry,
    MatchCandidate,
} from '@/lib/api/reconciliation';

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
    const variants: Record<string, string> = {
        unmatched: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
        auto: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
        confirmed: 'bg-green-500/10 text-green-600 border-green-500/20',
        manual: 'bg-green-500/10 text-green-600 border-green-500/20',
        ignored: 'bg-muted text-muted-foreground border-border',
    };
    return (
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${variants[status] ?? ''}`}>
            {status}
        </span>
    );
}

// ── Statement list ────────────────────────────────────────────────────────────

function StatementList({
    onSelect,
}: {
    onSelect: (s: BankStatement) => void;
}) {
    const { t } = useLanguage();
    const qc = useQueryClient();
    const [showCreate, setShowCreate] = useState(false);
    const [form, setForm] = useState<Partial<BankStatementCreate>>({});

    const { data: statements = [], isLoading } = useQuery({
        queryKey: ['reconciliation', 'statements'],
        queryFn: () => listStatements({ limit: 100 }),
    });

    const createMutation = useMutation({
        mutationFn: (body: BankStatementCreate) => createStatement(body),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['reconciliation', 'statements'] });
            setShowCreate(false);
            setForm({});
            toast.success('Statement created');
        },
        onError: () => toast.error('Failed to create statement'),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: number) => deleteStatement(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['reconciliation', 'statements'] });
            toast.success('Statement deleted');
        },
        onError: () => toast.error('Failed to delete statement'),
    });

    function handleCreate() {
        if (!form.bank_account || !form.period_start || !form.period_end) {
            toast.error('Bank account, period start and end are required');
            return;
        }
        createMutation.mutate(form as BankStatementCreate);
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('reconciliation.title')}
                subtitle={t('reconciliation.subtitle')}
                icon={GitCompare}
                actions={
                    <Button onClick={() => setShowCreate(true)}>
                        <Plus className="h-4 w-4 mr-2" />
                        {t('reconciliation.newStatement')}
                    </Button>
                }
            />

            {isLoading ? (
                <div className="space-y-3">
                    {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24" />)}
                </div>
            ) : statements.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
                        <GitCompare className="h-12 w-12 text-muted-foreground/40" />
                        <p className="text-muted-foreground">{t('reconciliation.noStatements')}</p>
                        <Button variant="outline" onClick={() => setShowCreate(true)}>
                            <Plus className="h-4 w-4 mr-2" />
                            {t('reconciliation.newStatement')}
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {statements.map((s) => (
                        <Card
                            key={s.id}
                            className="cursor-pointer hover:border-primary/50 transition-colors"
                            onClick={() => onSelect(s)}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex items-start justify-between gap-2">
                                    <CardTitle className="text-base font-semibold">{s.bank_account}</CardTitle>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (confirm(t('reconciliation.confirmDelete'))) {
                                                deleteMutation.mutate(s.id);
                                            }
                                        }}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {s.period_start} → {s.period_end}
                                </p>
                            </CardHeader>
                            <CardContent className="pt-0">
                                <div className="flex gap-3 text-sm">
                                    <span className="text-muted-foreground">
                                        {s.total_entries} {t('reconciliation.entries')}
                                    </span>
                                    {Number(s.unmatched_count) > 0 && (
                                        <Badge variant="outline" className="text-yellow-600 border-yellow-500/30 bg-yellow-500/5 text-xs px-1.5 py-0">
                                            {s.unmatched_count} {t('reconciliation.unmatched')}
                                        </Badge>
                                    )}
                                    {Number(s.matched_count) > 0 && (
                                        <Badge variant="outline" className="text-green-600 border-green-500/30 bg-green-500/5 text-xs px-1.5 py-0">
                                            {s.matched_count} {t('reconciliation.matched')}
                                        </Badge>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('reconciliation.newStatement')}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <Label>{t('reconciliation.bankAccount')}</Label>
                            <Input
                                placeholder="BE12 3456 7890 1234"
                                value={form.bank_account ?? ''}
                                onChange={(e) => setForm((f) => ({ ...f, bank_account: e.target.value }))}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label>{t('reconciliation.periodStart')}</Label>
                                <Input
                                    type="date"
                                    value={form.period_start ?? ''}
                                    onChange={(e) => setForm((f) => ({ ...f, period_start: e.target.value }))}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>{t('reconciliation.periodEnd')}</Label>
                                <Input
                                    type="date"
                                    value={form.period_end ?? ''}
                                    onChange={(e) => setForm((f) => ({ ...f, period_end: e.target.value }))}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label>{t('reconciliation.openingBalance')}</Label>
                                <Input
                                    type="number"
                                    step="0.01"
                                    placeholder="0.00"
                                    value={form.opening_balance ?? ''}
                                    onChange={(e) => setForm((f) => ({ ...f, opening_balance: e.target.value ? parseFloat(e.target.value) : undefined }))}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>{t('reconciliation.closingBalance')}</Label>
                                <Input
                                    type="number"
                                    step="0.01"
                                    placeholder="0.00"
                                    value={form.closing_balance ?? ''}
                                    onChange={(e) => setForm((f) => ({ ...f, closing_balance: e.target.value ? parseFloat(e.target.value) : undefined }))}
                                />
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreate(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button onClick={handleCreate} disabled={createMutation.isPending}>
                            {t('common.create')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

// ── Entry row with match candidates panel ─────────────────────────────────────

function EntryRow({
    entry,
    statementId,
    locale,
    onMatchChange,
}: {
    entry: ReconciliationEntry;
    statementId: number;
    locale: string;
    onMatchChange: () => void;
}) {
    const { t } = useLanguage();
    const [showCandidates, setShowCandidates] = useState(false);

    const { data: candidates = [], isLoading: loadingCandidates } = useQuery({
        queryKey: ['reconciliation', 'candidates', statementId, entry.id],
        queryFn: () => getMatchCandidates(statementId, entry.id),
        enabled: showCandidates,
    });

    const qc = useQueryClient();

    const matchMutation = useMutation({
        mutationFn: (transactionId: number) =>
            setMatch(statementId, entry.id, {
                transaction_id: transactionId,
                match_status: 'confirmed',
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['reconciliation', 'entries', statementId] });
            qc.invalidateQueries({ queryKey: ['reconciliation', 'statements'] });
            setShowCandidates(false);
            onMatchChange();
            toast.success(t('reconciliation.matchConfirmed'));
        },
        onError: () => toast.error(t('reconciliation.matchFailed')),
    });

    const ignoreMutation = useMutation({
        mutationFn: () =>
            setMatch(statementId, entry.id, {
                transaction_id: null,
                match_status: 'ignored',
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['reconciliation', 'entries', statementId] });
            onMatchChange();
            toast.success(t('reconciliation.entryIgnored'));
        },
        onError: () => toast.error(t('reconciliation.actionFailed')),
    });

    const clearMutation = useMutation({
        mutationFn: () => clearMatch(statementId, entry.id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['reconciliation', 'entries', statementId] });
            qc.invalidateQueries({ queryKey: ['reconciliation', 'statements'] });
            onMatchChange();
            toast.success(t('reconciliation.matchCleared'));
        },
        onError: () => toast.error(t('reconciliation.actionFailed')),
    });

    const isMatched = entry.match_status === 'confirmed' || entry.match_status === 'manual' || entry.match_status === 'auto';
    const isIgnored = entry.match_status === 'ignored';
    const amt = parseFloat(entry.amount);

    return (
        <>
            <TableRow className={isMatched ? 'opacity-60' : ''}>
                <TableCell className="text-sm font-mono">{entry.entry_date}</TableCell>
                <TableCell className="text-sm max-w-[200px] truncate">{entry.description ?? '—'}</TableCell>
                <TableCell className={`text-sm font-medium text-right tabular-nums ${amt < 0 ? 'text-red-500' : 'text-green-500'}`}>
                    {formatCurrency(Math.abs(amt), entry.currency, locale, { minimumFractionDigits: 2 })}
                    {amt < 0 ? ' −' : ' +'}
                </TableCell>
                <TableCell>
                    <StatusBadge status={entry.match_status} />
                </TableCell>
                <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                        {!isMatched && !isIgnored && (
                            <>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => setShowCandidates((v) => !v)}
                                >
                                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                                    {t('reconciliation.match')}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs text-muted-foreground"
                                    onClick={() => ignoreMutation.mutate()}
                                    disabled={ignoreMutation.isPending}
                                >
                                    <XCircle className="h-3.5 w-3.5 mr-1" />
                                    {t('reconciliation.ignore')}
                                </Button>
                            </>
                        )}
                        {(isMatched || isIgnored) && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-muted-foreground"
                                onClick={() => clearMutation.mutate()}
                                disabled={clearMutation.isPending}
                            >
                                <Unlink className="h-3.5 w-3.5 mr-1" />
                                {t('reconciliation.clear')}
                            </Button>
                        )}
                    </div>
                </TableCell>
            </TableRow>
            {showCandidates && (
                <TableRow>
                    <TableCell colSpan={5} className="p-0">
                        <div className="border-t bg-muted/30 px-4 py-3 space-y-2">
                            {loadingCandidates ? (
                                <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
                            ) : candidates.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t('reconciliation.noCandidates')}</p>
                            ) : (
                                <div className="space-y-1">
                                    <p className="text-xs font-medium text-muted-foreground mb-2">{t('reconciliation.candidatesLabel')}</p>
                                    {candidates.map((c: MatchCandidate) => (
                                        <div
                                            key={c.id}
                                            className="flex items-center justify-between rounded-md bg-background border px-3 py-2 gap-3"
                                        >
                                            <div className="flex gap-3 text-sm min-w-0">
                                                <span className="font-mono text-muted-foreground shrink-0">{c.date}</span>
                                                <span className="truncate">{c.recipient_name ?? c.memo ?? '—'}</span>
                                                <span className="tabular-nums shrink-0 font-medium">
                                                    {formatCurrency(Math.abs(parseFloat(c.amount)), c.currency, locale)}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <span className="text-xs text-muted-foreground">
                                                    {t('reconciliation.score')} {c.score}
                                                </span>
                                                <Button
                                                    size="sm"
                                                    className="h-7 text-xs"
                                                    onClick={() => matchMutation.mutate(c.id)}
                                                    disabled={matchMutation.isPending}
                                                >
                                                    {t('reconciliation.confirm')}
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </TableCell>
                </TableRow>
            )}
        </>
    );
}

// ── Statement detail view ─────────────────────────────────────────────────────

function StatementDetail({
    statement,
    onBack,
}: {
    statement: BankStatement;
    onBack: () => void;
}) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const qc = useQueryClient();

    const { data: entries = [], isLoading, refetch } = useQuery({
        queryKey: ['reconciliation', 'entries', statement.id],
        queryFn: () => listEntries(statement.id),
    });

    const unmatchedCount = entries.filter((e) => e.match_status === 'unmatched').length;
    const matchedCount = entries.filter(
        (e) => e.match_status === 'confirmed' || e.match_status === 'manual',
    ).length;
    const ignoredCount = entries.filter((e) => e.match_status === 'ignored').length;

    return (
        <div className="space-y-6">
            <PageHeader
                title={statement.bank_account}
                subtitle={`${statement.period_start} → ${statement.period_end}`}
                icon={GitCompare}
                actions={
                    <Button variant="outline" onClick={onBack}>
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        {t('common.back')}
                    </Button>
                }
            />

            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                    { label: t('reconciliation.totalEntries'), value: entries.length },
                    { label: t('reconciliation.unmatched'), value: unmatchedCount, warn: unmatchedCount > 0 },
                    { label: t('reconciliation.matched'), value: matchedCount },
                    { label: t('reconciliation.ignored'), value: ignoredCount },
                ].map(({ label, value, warn }) => (
                    <Card key={label}>
                        <CardContent className="pt-4 pb-3">
                            <p className="text-xs text-muted-foreground">{label}</p>
                            <p className={`text-2xl font-bold ${warn ? 'text-yellow-500' : ''}`}>{value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Balance check */}
            {statement.opening_balance != null && statement.closing_balance != null && (
                <Card>
                    <CardContent className="pt-4 pb-3">
                        <div className="flex gap-6 text-sm">
                            <div>
                                <span className="text-muted-foreground">{t('reconciliation.openingBalance')} </span>
                                <span className="font-medium">
                                    {formatCurrency(parseFloat(statement.opening_balance), statement.currency, locale)}
                                </span>
                            </div>
                            <div>
                                <span className="text-muted-foreground">{t('reconciliation.closingBalance')} </span>
                                <span className="font-medium">
                                    {formatCurrency(parseFloat(statement.closing_balance), statement.currency, locale)}
                                </span>
                            </div>
                            <div>
                                <span className="text-muted-foreground">{t('reconciliation.net')} </span>
                                <span className="font-medium">
                                    {formatCurrency(
                                        parseFloat(statement.closing_balance) - parseFloat(statement.opening_balance),
                                        statement.currency,
                                        locale,
                                    )}
                                </span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Entry table */}
            <Card>
                <CardContent className="p-0">
                    {isLoading ? (
                        <div className="p-4 space-y-2">
                            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10" />)}
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
                            <Circle className="h-10 w-10 text-muted-foreground/30" />
                            <p className="text-muted-foreground text-sm">{t('reconciliation.noEntries')}</p>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('reconciliation.date')}</TableHead>
                                    <TableHead>{t('reconciliation.description')}</TableHead>
                                    <TableHead className="text-right">{t('reconciliation.amount')}</TableHead>
                                    <TableHead>{t('reconciliation.status')}</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {entries.map((entry) => (
                                    <EntryRow
                                        key={entry.id}
                                        entry={entry}
                                        statementId={statement.id}
                                        locale={locale}
                                        onMatchChange={() => {
                                            qc.invalidateQueries({ queryKey: ['reconciliation', 'entries', statement.id] });
                                        }}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function ReconciliationPage() {
    const [selectedStatement, setSelectedStatement] = useState<BankStatement | null>(null);

    if (selectedStatement) {
        return (
            <StatementDetail
                statement={selectedStatement}
                onBack={() => setSelectedStatement(null)}
            />
        );
    }

    return <StatementList onSelect={setSelectedStatement} />;
}
