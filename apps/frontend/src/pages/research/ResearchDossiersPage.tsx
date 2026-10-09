import { useEffect, useId, useRef, useState } from "react";
import {
    AlertTriangle,
    Check,
    Download,
    Plus,
    RotateCcw,
    Save,
    Trash2,
} from "lucide-react";
import { apiClient, ApiClientError } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { PAGE_ICONS } from "@/lib/pageIcons";
import type {
    DossierContent,
    DossierEvidence,
    EvidenceOrigin,
    EvidenceStance,
} from "@/lib/api/dossiers";
import type { AnalysisWorkspace } from "@/lib/api/analysis";
import {
    useDossier,
    useDossierActions,
    useDossierVersions,
    useDossiers,
    useDossierPickers,
} from "@/hooks/useDossiers";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { cn } from "@/lib/utils";
import { SELECT_NONE, toSelectValue } from "@/lib/selectValue";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { PageError } from "@/components/shared/PageError";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { List, ListRow } from "@/components/ui/list";
import {
    Disclosure,
    DisclosureContent,
    DisclosureSummary,
} from "@/components/ui/disclosure";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RowMenu } from "@/components/shared/RowMenu";

const WORKSPACES = [
    "budgeting",
    "portfolio",
    "research",
    "cross-workspace",
] as const satisfies ReadonlyArray<AnalysisWorkspace>;
const ORIGINS = [
    "user",
    "ai-draft",
] as const satisfies ReadonlyArray<EvidenceOrigin>;
const STANCES = [
    "support",
    "oppose",
    "context",
] as const satisfies ReadonlyArray<EvidenceStance>;

const emptyContent = (): DossierContent => ({
    title: "",
    workspace: "research",
    question: "",
    userThesis: "",
    assumptions: [],
    openQuestions: [],
    conclusion: "",
    reviewDate: null,
    evidence: [],
    links: { categoryIds: [], investmentIds: [], savedAnalysisIds: [] },
});

const emptyEvidence = (): DossierEvidence => ({
    id: crypto.randomUUID(),
    stance: "context",
    origin: "user",
    claim: "",
    source: {
        title: "",
        reference: "",
        sourceDate: null,
        accessedAt: null,
    },
    notes: "",
});

function downloadJson(name: string, data: unknown) {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

function LinesField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string[];
    onChange: (lines: string[]) => void;
}) {
    const inputId = useId();
    return (
        <div className="space-y-2">
            <Label htmlFor={inputId}>{label}</Label>
            <Textarea
                id={inputId}
                value={value.join("\n")}
                onChange={(event) =>
                    onChange(
                        event.target.value
                            .split("\n")
                            .filter((line) => line.trim()),
                    )
                }
                rows={3}
            />
        </div>
    );
}

export default function ResearchDossiersPage() {
    const { t } = useLanguage();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [listOffset, setListOffset] = useState(0);
    const [draft, setDraft] = useState<DossierContent | null>(null);
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState(false);
    const [notice, setNotice] = useState("");
    const loadedRevision = useRef<string | null>(null);
    const savedContent = useRef<string | null>(null);
    const list = useDossiers(listOffset);
    const detail = useDossier(selectedId);
    const history = useDossierVersions(selectedId);
    const actions = useDossierActions();
    const { categories, investments, analyses, documents } =
        useDossierPickers();

    useEffect(() => {
        if (!selectedId || !detail.data) return;
        const revision = `${detail.data.id}:${detail.data.version}`;
        if (loadedRevision.current === revision) return;
        loadedRevision.current = revision;
        const {
            title,
            workspace,
            question,
            userThesis,
            assumptions,
            openQuestions,
            conclusion,
            reviewDate,
            evidence,
            links,
        } = detail.data;
        const content = {
            title,
            workspace,
            question,
            userThesis,
            assumptions,
            openQuestions,
            conclusion,
            reviewDate,
            evidence,
            links,
        };
        savedContent.current = JSON.stringify(content);
        setDraft(content);
    }, [selectedId, detail.data]);

    const edit = (patch: Partial<DossierContent>) =>
        setDraft((current) => (current ? { ...current, ...patch } : current));
    const confirmDiscard = async () =>
        !draft ||
        JSON.stringify(draft) === savedContent.current ||
        (await confirm({
            title: t("dossiers.discardChangesTitle"),
            description: t("dossiers.discardChangesConfirm"),
            confirmLabel: t("dossiers.discardChanges"),
            variant: "destructive",
        }));
    const choose = async (id: string, afterSave = false) => {
        if (id === selectedId) return;
        if (!afterSave && !(await confirmDiscard())) return;
        loadedRevision.current = null;
        savedContent.current = null;
        setSelectedId(id);
        setDraft(null);
        setError("");
        setConflict(false);
        setNotice("");
    };
    const create = async () => {
        if (!(await confirmDiscard())) return;
        const content = emptyContent();
        loadedRevision.current = null;
        savedContent.current = JSON.stringify(content);
        setSelectedId(null);
        setDraft(content);
        setError("");
        setConflict(false);
        setNotice("");
    };
    const run = async (operation: () => Promise<void>) => {
        setError("");
        setConflict(false);
        setNotice("");
        try {
            await operation();
        } catch (cause) {
            setError(apiErrorToMessage(cause, t));
            setConflict(
                cause instanceof ApiClientError && cause.status === 409,
            );
        }
    };
    const save = () =>
        run(async () => {
            if (!draft) return;
            if (!draft.title.trim() || !draft.question.trim()) {
                setError(t("dossiers.required"));
                return;
            }
            if (selectedId) {
                if (!detail.data) return;
                const saved = await actions.update.mutateAsync({
                    id: selectedId,
                    content: draft,
                    expectedVersion: detail.data.version,
                });
                loadedRevision.current = null;
                const content = { ...draft, evidence: saved.evidence };
                savedContent.current = JSON.stringify(content);
                setDraft(content);
            } else {
                const saved = await actions.create.mutateAsync(draft);
                await choose(saved.id, true);
            }
            setNotice(t("dossiers.saved"));
        });
    // Deleting a dossier removes its whole version history and has no restore
    // endpoint, so it keeps its confirmation (ADR-179 Undo rule).
    const remove = async () => {
        if (!selectedId) return;
        const ok = await confirm({
            title: t("dossiers.deleteTitle"),
            description: t("dossiers.deleteConfirm"),
            confirmLabel: t("dossiers.delete"),
            variant: "destructive",
        });
        if (!ok) return;
        await run(async () => {
            await actions.remove.mutateAsync(selectedId);
            setSelectedId(null);
            setDraft(null);
            setNotice(t("dossiers.deleted"));
        });
    };
    const restore = async (version: number) => {
        if (!selectedId || !detail.data) return;
        const ok = await confirm({
            title: t("dossiers.restoreTitle"),
            description: t("dossiers.restoreConfirm"),
            confirmLabel: t("dossiers.restore"),
        });
        if (!ok) return;
        const expectedVersion = detail.data.version;
        await run(async () => {
            await actions.restore.mutateAsync({
                id: selectedId,
                version,
                expectedVersion,
            });
            loadedRevision.current = null;
            setNotice(t("dossiers.restored"));
        });
    };
    const reloadLatest = async () => {
        const ok = await confirm({
            title: t("dossiers.reloadTitle"),
            description: t("dossiers.reloadConfirm"),
            confirmLabel: t("dossiers.reloadLatest"),
            variant: "destructive",
        });
        if (!ok) return;
        loadedRevision.current = null;
        setDraft(null);
        setError("");
        setConflict(false);
        void detail.refetch();
    };
    const exportJson = (id?: string) =>
        run(async () => {
            const data = id
                ? await apiClient.exportDossier(id)
                : await apiClient.exportDossiers();
            downloadJson(
                id ? `vision-dossier-${id}.json` : "vision-dossiers.json",
                data,
            );
        });
    const updateEvidence = (id: string, patch: Partial<DossierEvidence>) =>
        edit({
            evidence: (draft?.evidence ?? []).map((item) =>
                item.id === id ? { ...item, ...patch } : item,
            ),
        });
    const toggleLink = (
        field: keyof DossierContent["links"],
        id: number | string,
    ) => {
        if (!draft) return;
        const values = draft.links[field] as Array<number | string>;
        const next = values.includes(id)
            ? values.filter((item) => item !== id)
            : [...values, id];
        edit({ links: { ...draft.links, [field]: next } });
    };
    const busy =
        actions.create.isPending ||
        actions.update.isPending ||
        actions.remove.isPending ||
        actions.restore.isPending;

    const items = list.data?.items ?? [];
    const readyDocuments =
        documents.data?.filter(
            (document) => document.extractionStatus === "ready",
        ) ?? [];

    return (
        <PageShell>
            <ConfirmDialog />
            <PageHeader
                title={t("dossiers.title")}
                subtitle={t("dossiers.subtitle")}
                icon={PAGE_ICONS["/research/dossiers"]}
                actions={
                    <>
                        <RowMenu
                            variant="outline"
                            size="icon"
                            label={t("dossiers.menu")}
                        >
                            <DropdownMenuItem
                                onSelect={() => void exportJson()}
                            >
                                <Download className="mr-2 h-4 w-4 text-label-secondary" />
                                {t("dossiers.exportAll")}
                            </DropdownMenuItem>
                        </RowMenu>
                        <Button onClick={() => void create()}>
                            <Plus />
                            {t("dossiers.new")}
                        </Button>
                    </>
                }
            />

            {error && (
                <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    <AlertDescription>
                        <p>{error}</p>
                        {conflict && selectedId && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-3"
                                onClick={() => void reloadLatest()}
                            >
                                {t("dossiers.reloadLatest")}
                            </Button>
                        )}
                    </AlertDescription>
                </Alert>
            )}
            {notice && (
                <Alert variant="success">
                    <Check className="h-4 w-4" aria-hidden="true" />
                    <AlertDescription>{notice}</AlertDescription>
                </Alert>
            )}

            <div
                className={cn(
                    "grid items-start gap-6",
                    (items.length > 0 ||
                        draft ||
                        selectedId ||
                        list.isLoading ||
                        list.isError) &&
                        "lg:grid-cols-[minmax(14rem,19rem)_1fr]",
                )}
            >
                {(items.length > 0 ||
                    draft ||
                    selectedId ||
                    list.isLoading ||
                    list.isError) && (
                    <aside
                        aria-label={t("dossiers.list")}
                        className="space-y-3"
                    >
                        <h2 className="type-headline text-label-secondary">
                            {t("dossiers.list")}
                        </h2>
                        {list.isLoading && (
                            <div {...loadingSurfaceProps} className="space-y-2">
                                {[1, 2, 3].map((i) => (
                                    <Skeleton key={i} className="h-14 w-full" />
                                ))}
                            </div>
                        )}
                        {list.isError && (
                            <PageError
                                message={apiErrorToMessage(list.error, t)}
                                onRetry={() => void list.refetch()}
                            />
                        )}
                        {!list.isLoading &&
                            !list.isError &&
                            items.length === 0 && (
                                <Card>
                                    <CardContent variant="state">
                                        <EmptyState
                                            size="compact"
                                            headingLevel={3}
                                            icon={
                                                PAGE_ICONS["/research/dossiers"]
                                            }
                                            title={t("dossiers.empty")}
                                        />
                                    </CardContent>
                                </Card>
                            )}
                        {items.length > 0 && (
                            <List>
                                {items.map((item) => {
                                    const selected = selectedId === item.id;
                                    return (
                                        <ListRow
                                            key={item.id}
                                            aria-current={
                                                selected ? "page" : undefined
                                            }
                                            className={cn(
                                                selected && "bg-primary/10",
                                            )}
                                            onActivate={() =>
                                                void choose(item.id)
                                            }
                                            title={
                                                <span
                                                    className={cn(
                                                        selected &&
                                                            "font-medium",
                                                    )}
                                                >
                                                    {item.title}
                                                </span>
                                            }
                                            subtitle={`${t(`dossiers.workspace.${item.workspace}`)} · ${t("dossiers.version", { version: item.version })}`}
                                        />
                                    );
                                })}
                            </List>
                        )}
                        {list.data && list.data.total > 500 && (
                            <div className="flex flex-wrap items-center gap-2 type-footnote text-label-secondary">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={listOffset === 0}
                                    onClick={() =>
                                        setListOffset(
                                            Math.max(0, listOffset - 500),
                                        )
                                    }
                                >
                                    {t("dossiers.previous")}
                                </Button>
                                <span className="tabular-nums">
                                    {t("dossiers.pageRange", {
                                        first: listOffset + 1,
                                        last: Math.min(
                                            listOffset + 500,
                                            list.data.total,
                                        ),
                                        total: list.data.total,
                                    })}
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={
                                        listOffset + 500 >= list.data.total
                                    }
                                    onClick={() =>
                                        setListOffset(listOffset + 500)
                                    }
                                >
                                    {t("dossiers.next")}
                                </Button>
                            </div>
                        )}
                    </aside>
                )}

                <div className="min-w-0 space-y-6">
                    {selectedId && detail.isLoading && (
                        <Card>
                            <CardContent
                                {...loadingSurfaceProps}
                                variant="headerless"
                                className="space-y-3"
                            >
                                <Skeleton className="h-8 w-64" />
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-20 w-full" />
                            </CardContent>
                        </Card>
                    )}
                    {selectedId && detail.isError && (
                        <Card>
                            <CardContent variant="flush">
                                <PageError
                                    message={apiErrorToMessage(detail.error, t)}
                                    onRetry={() => void detail.refetch()}
                                />
                            </CardContent>
                        </Card>
                    )}
                    {!draft &&
                        !selectedId &&
                        !list.isLoading &&
                        !list.isError && (
                            <Card>
                                <CardContent variant="state">
                                    <EmptyState
                                        icon={PAGE_ICONS["/research/dossiers"]}
                                        title={t(
                                            items.length > 0
                                                ? "dossiers.select"
                                                : "dossiers.empty",
                                        )}
                                        description={
                                            items.length === 0
                                                ? t("dossiers.emptyHint")
                                                : undefined
                                        }
                                    />
                                </CardContent>
                            </Card>
                        )}
                    {draft && (
                        <form
                            className="space-y-6"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void save();
                            }}
                        >
                            <Card>
                                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                                    <div className="min-w-0 space-y-1">
                                        <CardTitle
                                            variant="sm"
                                            className="truncate"
                                        >
                                            {draft.title.trim() ||
                                                t("dossiers.new")}
                                        </CardTitle>
                                        {selectedId && detail.data && (
                                            <CardDescription>
                                                {t(
                                                    `dossiers.workspace.${detail.data.workspace}`,
                                                )}{" "}
                                                ·{" "}
                                                {t("dossiers.version", {
                                                    version:
                                                        detail.data.version,
                                                })}
                                            </CardDescription>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {selectedId && (
                                            <RowMenu
                                                variant="outline"
                                                size="icon"
                                                label={t("dossiers.editorMenu")}
                                            >
                                                <DropdownMenuItem
                                                    onSelect={() =>
                                                        void exportJson(
                                                            selectedId,
                                                        )
                                                    }
                                                >
                                                    <Download className="mr-2 h-4 w-4 text-label-secondary" />
                                                    {t("dossiers.exportOne")}
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    disabled={busy}
                                                    variant="destructive"
                                                    onSelect={() =>
                                                        void remove()
                                                    }
                                                >
                                                    <Trash2 className="mr-2 h-4 w-4" />
                                                    {t("dossiers.delete")}
                                                </DropdownMenuItem>
                                            </RowMenu>
                                        )}
                                        <Button type="submit" disabled={busy}>
                                            <Save />
                                            {t("dossiers.save")}
                                        </Button>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-5">
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label htmlFor="dossier-title">
                                                {t("dossiers.field.title")}
                                            </Label>
                                            <Input
                                                id="dossier-title"
                                                required
                                                value={draft.title}
                                                onChange={(event) =>
                                                    edit({
                                                        title: event.target
                                                            .value,
                                                    })
                                                }
                                            />
                                        </div>
                                        <div className="min-w-0 space-y-2">
                                            <Label htmlFor="dossier-workspace">
                                                {t("dossiers.field.workspace")}
                                            </Label>
                                            <Select
                                                value={draft.workspace}
                                                onValueChange={(value) =>
                                                    edit({
                                                        workspace:
                                                            value as AnalysisWorkspace,
                                                    })
                                                }
                                            >
                                                <SelectTrigger
                                                    id="dossier-workspace"
                                                    className="w-full"
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {WORKSPACES.map((value) => (
                                                        <SelectItem
                                                            key={value}
                                                            value={value}
                                                        >
                                                            {t(
                                                                `dossiers.workspace.${value}`,
                                                            )}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="dossier-question">
                                            {t("dossiers.field.question")}
                                        </Label>
                                        <Textarea
                                            id="dossier-question"
                                            required
                                            value={draft.question}
                                            onChange={(event) =>
                                                edit({
                                                    question:
                                                        event.target.value,
                                                })
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="dossier-thesis">
                                            {t("dossiers.field.thesis")}
                                        </Label>
                                        <Textarea
                                            id="dossier-thesis"
                                            value={draft.userThesis}
                                            onChange={(event) =>
                                                edit({
                                                    userThesis:
                                                        event.target.value,
                                                })
                                            }
                                        />
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <LinesField
                                            label={t(
                                                "dossiers.field.assumptions",
                                            )}
                                            value={draft.assumptions}
                                            onChange={(assumptions) =>
                                                edit({ assumptions })
                                            }
                                        />
                                        <LinesField
                                            label={t(
                                                "dossiers.field.openQuestions",
                                            )}
                                            value={draft.openQuestions}
                                            onChange={(openQuestions) =>
                                                edit({ openQuestions })
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="dossier-conclusion">
                                            {t("dossiers.field.conclusion")}
                                        </Label>
                                        <Textarea
                                            id="dossier-conclusion"
                                            value={draft.conclusion}
                                            onChange={(event) =>
                                                edit({
                                                    conclusion:
                                                        event.target.value,
                                                })
                                            }
                                            rows={5}
                                        />
                                    </div>
                                    <div className="space-y-2 md:max-w-xs">
                                        <Label htmlFor="dossier-review">
                                            {t("dossiers.field.reviewDate")}
                                        </Label>
                                        <Input
                                            id="dossier-review"
                                            type="date"
                                            value={draft.reviewDate ?? ""}
                                            onChange={(event) =>
                                                edit({
                                                    reviewDate:
                                                        event.target.value ||
                                                        null,
                                                })
                                            }
                                        />
                                    </div>
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                                    <div className="min-w-0 space-y-1">
                                        <CardTitle variant="sm">
                                            {t("dossiers.evidence")}
                                        </CardTitle>
                                        <CardDescription>
                                            {t("dossiers.evidenceHint")}
                                        </CardDescription>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={draft.evidence.length >= 30}
                                        onClick={() =>
                                            edit({
                                                evidence: [
                                                    ...draft.evidence,
                                                    emptyEvidence(),
                                                ],
                                            })
                                        }
                                    >
                                        <Plus />
                                        {t("dossiers.addEvidence")}
                                    </Button>
                                </CardHeader>
                                {draft.evidence.length > 0 && (
                                    <CardContent className="divide-y divide-border/50">
                                        {draft.evidence.map((item, index) => (
                                            <EvidenceEditor
                                                key={item.id}
                                                item={item}
                                                index={index}
                                                documents={readyDocuments}
                                                documentsError={
                                                    documents.isError
                                                }
                                                documentMissing={
                                                    !!item.source.documentId &&
                                                    !documents.data?.some(
                                                        (document) =>
                                                            document.id ===
                                                            item.source
                                                                .documentId,
                                                    )
                                                }
                                                onChange={(patch) =>
                                                    updateEvidence(
                                                        item.id,
                                                        patch,
                                                    )
                                                }
                                                onRemove={() =>
                                                    edit({
                                                        evidence:
                                                            draft.evidence.filter(
                                                                (entry) =>
                                                                    entry.id !==
                                                                    item.id,
                                                            ),
                                                    })
                                                }
                                            />
                                        ))}
                                    </CardContent>
                                )}
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle variant="sm">
                                        {t("dossiers.links")}
                                    </CardTitle>
                                    <CardDescription>
                                        {t("dossiers.linksHint")}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {detail.data?.linkDetails
                                        ?.filter(
                                            (entry) =>
                                                entry.status === "deleted",
                                        )
                                        .map((entry) => (
                                            <Alert
                                                key={`${entry.kind}-${entry.historicalId}`}
                                                variant="warning"
                                            >
                                                <AlertTriangle
                                                    className="h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                                <AlertDescription>
                                                    {t("dossiers.deletedLink", {
                                                        label: entry.labelSnapshot,
                                                        id: entry.historicalId,
                                                    })}
                                                </AlertDescription>
                                            </Alert>
                                        ))}
                                    <div className="grid items-start gap-3 lg:grid-cols-3">
                                        <DossierLinkPicker
                                            label={t("dossiers.linkCategories")}
                                            items={(
                                                categories.data?.items ?? []
                                            ).map((item) => ({
                                                id: item.id,
                                                label: item.path.join(" / "),
                                            }))}
                                            selected={draft.links.categoryIds}
                                            error={categories.isError}
                                            onToggle={(id) =>
                                                toggleLink("categoryIds", id)
                                            }
                                        />
                                        <DossierLinkPicker
                                            label={t(
                                                "dossiers.linkInvestments",
                                            )}
                                            items={(
                                                investments.data?.items ?? []
                                            ).map((item) => ({
                                                id: item.id,
                                                label: item.name,
                                            }))}
                                            selected={draft.links.investmentIds}
                                            error={investments.isError}
                                            onToggle={(id) =>
                                                toggleLink("investmentIds", id)
                                            }
                                        />
                                        <DossierLinkPicker
                                            label={t("dossiers.linkAnalyses")}
                                            items={(analyses.data ?? []).map(
                                                (item) => ({
                                                    id: item.id,
                                                    label: item.name,
                                                }),
                                            )}
                                            selected={
                                                draft.links.savedAnalysisIds
                                            }
                                            error={analyses.isError}
                                            onToggle={(id) =>
                                                toggleLink(
                                                    "savedAnalysisIds",
                                                    id,
                                                )
                                            }
                                        />
                                    </div>
                                </CardContent>
                            </Card>

                            {selectedId && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle variant="sm">
                                            {t("dossiers.history")}
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        {history.isError && (
                                            <Alert variant="destructive">
                                                <AlertTriangle
                                                    className="h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                                <AlertDescription>
                                                    {t("dossiers.historyError")}
                                                </AlertDescription>
                                            </Alert>
                                        )}
                                        {history.data &&
                                            history.data.length > 0 && (
                                                <List>
                                                    {history.data.map(
                                                        (entry) => (
                                                            <ListRow
                                                                key={
                                                                    entry.version
                                                                }
                                                                title={`${t("dossiers.version", { version: entry.version })} · ${new Date(entry.createdAt).toLocaleString()}`}
                                                                subtitle={
                                                                    entry
                                                                        .snapshot
                                                                        .conclusion ||
                                                                    t(
                                                                        "dossiers.noConclusion",
                                                                    )
                                                                }
                                                                trailing={
                                                                    <Button
                                                                        type="button"
                                                                        variant="outline"
                                                                        size="sm"
                                                                        disabled={
                                                                            busy ||
                                                                            entry.version ===
                                                                                detail
                                                                                    .data
                                                                                    ?.version
                                                                        }
                                                                        onClick={() =>
                                                                            void restore(
                                                                                entry.version,
                                                                            )
                                                                        }
                                                                    >
                                                                        <RotateCcw />
                                                                        {t(
                                                                            "dossiers.restore",
                                                                        )}
                                                                    </Button>
                                                                }
                                                            />
                                                        ),
                                                    )}
                                                </List>
                                            )}
                                    </CardContent>
                                </Card>
                            )}
                        </form>
                    )}
                </div>
            </div>
        </PageShell>
    );
}

interface EvidenceEditorProps {
    item: DossierEvidence;
    index: number;
    documents: Array<{ id: string; title: string; version: number }>;
    documentsError: boolean;
    documentMissing: boolean;
    onChange: (patch: Partial<DossierEvidence>) => void;
    onRemove: () => void;
}

function EvidenceEditor({
    item,
    index,
    documents,
    documentsError,
    documentMissing,
    onChange,
    onRemove,
}: EvidenceEditorProps) {
    const { t } = useLanguage();
    const headingId = `evidence-heading-${item.id}`;
    const updateSource = (patch: Partial<DossierEvidence["source"]>) =>
        onChange({ source: { ...item.source, ...patch } });

    return (
        <section
            aria-labelledby={headingId}
            className="space-y-4 py-5 first:pt-0 last:pb-0"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={headingId} className="type-headline text-foreground">
                    {t("dossiers.evidenceNumber", { number: index + 1 })} ·{" "}
                    {t(`dossiers.origin.${item.origin}`)}
                </h3>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={onRemove}
                >
                    <Trash2 />
                    {t("dossiers.removeEvidence")}
                </Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                <SegmentedControl
                    label={t("dossiers.field.origin")}
                    size="sm"
                    className="w-full"
                    value={item.origin}
                    onValueChange={(value) =>
                        onChange({ origin: value as EvidenceOrigin })
                    }
                >
                    {ORIGINS.map((origin) => (
                        <SegmentedControlItem key={origin} value={origin}>
                            {t(`dossiers.origin.${origin}`)}
                        </SegmentedControlItem>
                    ))}
                </SegmentedControl>
                <SegmentedControl
                    label={t("dossiers.field.stance")}
                    size="sm"
                    className="w-full"
                    value={item.stance}
                    onValueChange={(value) =>
                        onChange({ stance: value as EvidenceStance })
                    }
                >
                    {STANCES.map((stance) => (
                        <SegmentedControlItem key={stance} value={stance}>
                            {t(`dossiers.stance.${stance}`)}
                        </SegmentedControlItem>
                    ))}
                </SegmentedControl>
            </div>
            <div className="space-y-2">
                <Label htmlFor={`claim-${item.id}`}>
                    {t("dossiers.field.claim")}
                </Label>
                <Textarea
                    id={`claim-${item.id}`}
                    required
                    value={item.claim}
                    onChange={(event) =>
                        onChange({ claim: event.target.value })
                    }
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor={`source-document-${item.id}`}>
                    {t("dossiers.field.document")}
                </Label>
                <Select
                    value={toSelectValue(item.source.documentId)}
                    onValueChange={(value) => {
                        const document = documents.find(
                            (candidate) => candidate.id === value,
                        );
                        const {
                            documentId: _documentId,
                            documentVersion: _documentVersion,
                            passageOrdinal: _passageOrdinal,
                            contentSha256: _contentSha256,
                            ...rest
                        } = item.source;
                        onChange({
                            source: document
                                ? {
                                      ...rest,
                                      documentId: document.id,
                                      documentVersion: document.version,
                                      title: rest.title || document.title,
                                  }
                                : rest,
                        });
                    }}
                >
                    <SelectTrigger id={`source-document-${item.id}`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={SELECT_NONE}>
                            {t("dossiers.noDocument")}
                        </SelectItem>
                        {documents.map((document) => (
                            <SelectItem key={document.id} value={document.id}>
                                {document.title}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {documentsError && (
                    <p role="alert" className="type-footnote text-destructive">
                        {t("dossiers.documentsError")}
                    </p>
                )}
                {documentMissing && (
                    <p className="type-footnote text-warning">
                        {t("dossiers.documentUnavailable")}
                    </p>
                )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor={`source-title-${item.id}`}>
                        {t("dossiers.field.sourceTitle")}
                    </Label>
                    <Input
                        id={`source-title-${item.id}`}
                        required
                        value={item.source.title}
                        onChange={(event) =>
                            updateSource({ title: event.target.value })
                        }
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`source-ref-${item.id}`}>
                        {t("dossiers.field.sourceReference")}
                    </Label>
                    <Input
                        id={`source-ref-${item.id}`}
                        required
                        value={item.source.reference}
                        onChange={(event) =>
                            updateSource({ reference: event.target.value })
                        }
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`source-date-${item.id}`}>
                        {t("dossiers.field.sourceDate")}
                    </Label>
                    <Input
                        id={`source-date-${item.id}`}
                        type="date"
                        value={item.source.sourceDate ?? ""}
                        onChange={(event) =>
                            updateSource({
                                sourceDate: event.target.value || null,
                            })
                        }
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`source-accessed-${item.id}`}>
                        {t("dossiers.field.accessedAt")}
                    </Label>
                    <Input
                        id={`source-accessed-${item.id}`}
                        type="datetime-local"
                        value={item.source.accessedAt?.slice(0, 16) ?? ""}
                        onChange={(event) =>
                            updateSource({
                                accessedAt: event.target.value
                                    ? new Date(event.target.value).toISOString()
                                    : null,
                            })
                        }
                    />
                </div>
            </div>
            <div className="space-y-2">
                <Label htmlFor={`notes-${item.id}`}>
                    {t("dossiers.field.notes")}
                </Label>
                <Textarea
                    id={`notes-${item.id}`}
                    value={item.notes}
                    onChange={(event) =>
                        onChange({ notes: event.target.value })
                    }
                />
            </div>
            {(item.source.documentId || item.source.contentSha256) && (
                <p className="break-all type-caption text-label-tertiary">
                    {t("dossiers.documentAnchor", {
                        id: item.source.documentId ?? "—",
                        version: item.source.documentVersion ?? "—",
                        passage: item.source.passageOrdinal ?? "—",
                        hash: item.source.contentSha256 ?? "—",
                    })}
                </p>
            )}
        </section>
    );
}

function DossierLinkPicker<T extends string | number>({
    label,
    items,
    selected,
    error,
    onToggle,
}: {
    label: string;
    items: Array<{ id: T; label: string }>;
    selected: T[];
    error: boolean;
    onToggle: (id: T) => void;
}) {
    const { t } = useLanguage();
    const pickerId = useId();
    const [query, setQuery] = useState("");
    const visibleItems = items.filter((item) =>
        item.label
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
    );
    return (
        <div className="space-y-2">
            {error && (
                <p role="alert" className="type-footnote text-destructive">
                    {t("dossiers.linksError")}
                </p>
            )}
            <Disclosure variant="card">
                <DisclosureSummary padded>
                    {label}
                    <span className="ml-2 type-footnote font-normal text-label-secondary">
                        {t("dossiers.linksSelected", {
                            count: selected.length,
                        })}
                    </span>
                </DisclosureSummary>
                <DisclosureContent className="space-y-3 border-t border-border/50 p-3">
                    {items.length > 8 && (
                        <Input
                            type="search"
                            value={query}
                            aria-label={t("dossiers.searchLinks", {
                                type: label,
                            })}
                            placeholder={t("dossiers.searchLinks", {
                                type: label,
                            })}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    )}
                    <div className="max-h-56 overflow-auto">
                        <ul className="m-0 list-none space-y-0.5 p-0">
                            {visibleItems.map((item) => {
                                const id = `${pickerId}-${item.id}`;
                                return (
                                    <li
                                        key={item.id}
                                        className="flex min-h-9 items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-foreground/[0.04]"
                                    >
                                        <Checkbox
                                            id={id}
                                            checked={selected.includes(item.id)}
                                            onCheckedChange={() =>
                                                onToggle(item.id)
                                            }
                                        />
                                        <Label
                                            htmlFor={id}
                                            className="flex-1 cursor-pointer font-normal"
                                        >
                                            {item.label}
                                        </Label>
                                    </li>
                                );
                            })}
                        </ul>
                        {!error && visibleItems.length === 0 && (
                            <p className="px-2 py-1.5 type-footnote text-label-secondary">
                                {t("dossiers.noMatchingLinks")}
                            </p>
                        )}
                    </div>
                </DisclosureContent>
            </Disclosure>
        </div>
    );
}
