import { useEffect, useRef, useState } from "react";
import {
    BookOpen,
    Download,
    Plus,
    RotateCcw,
    Save,
    Trash2,
} from "lucide-react";
import { apiClient, ApiClientError } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
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
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
    return (
        <div className="space-y-1">
            <Label>{label}</Label>
            <Textarea
                aria-label={label}
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
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [listOffset, setListOffset] = useState(0);
    const [draft, setDraft] = useState<DossierContent | null>(null);
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState(false);
    const [notice, setNotice] = useState("");
    const loadedRevision = useRef<string | null>(null);
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
        setDraft({
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
        });
    }, [selectedId, detail.data]);

    const edit = (patch: Partial<DossierContent>) =>
        setDraft((current) => (current ? { ...current, ...patch } : current));
    const choose = (id: string) => {
        loadedRevision.current = null;
        setSelectedId(id);
        setDraft(null);
        setError("");
        setConflict(false);
        setNotice("");
    };
    const create = () => {
        loadedRevision.current = null;
        setSelectedId(null);
        setDraft(emptyContent());
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
                setDraft({ ...draft, evidence: saved.evidence });
            } else {
                const saved = await actions.create.mutateAsync(draft);
                choose(saved.id);
            }
            setNotice(t("dossiers.saved"));
        });
    const remove = () =>
        run(async () => {
            if (!selectedId || !window.confirm(t("dossiers.deleteConfirm")))
                return;
            await actions.remove.mutateAsync(selectedId);
            setSelectedId(null);
            setDraft(null);
            setNotice(t("dossiers.deleted"));
        });
    const restore = (version: number) =>
        run(async () => {
            if (
                !selectedId ||
                !detail.data ||
                !window.confirm(t("dossiers.restoreConfirm"))
            )
                return;
            await actions.restore.mutateAsync({
                id: selectedId,
                version,
                expectedVersion: detail.data.version,
            });
            loadedRevision.current = null;
            setNotice(t("dossiers.restored"));
        });
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

    return (
        <PageShell>
            <PageHeader
                title={t("dossiers.title")}
                subtitle={t("dossiers.subtitle")}
                icon={BookOpen}
                actions={
                    <>
                        <Button
                            variant="outline"
                            onClick={() => void exportJson()}
                        >
                            <Download className="mr-2 size-4" />
                            {t("dossiers.exportAll")}
                        </Button>
                        <Button onClick={create}>
                            <Plus className="mr-2 size-4" />
                            {t("dossiers.new")}
                        </Button>
                    </>
                }
            />
            {error && (
                <div
                    role="alert"
                    className="rounded-md border border-destructive p-3 text-destructive"
                >
                    <p>{error}</p>
                    {conflict && selectedId && (
                        <Button
                            type="button"
                            variant="outline"
                            className="mt-2"
                            onClick={() => {
                                if (
                                    !window.confirm(t("dossiers.reloadConfirm"))
                                )
                                    return;
                                loadedRevision.current = null;
                                setDraft(null);
                                setError("");
                                setConflict(false);
                                void detail.refetch();
                            }}
                        >
                            {t("dossiers.reloadLatest")}
                        </Button>
                    )}
                </div>
            )}
            {notice && (
                <p role="status" className="rounded-md border p-3">
                    {notice}
                </p>
            )}
            <div className="grid gap-6 lg:grid-cols-[minmax(14rem,19rem)_1fr]">
                <aside aria-label={t("dossiers.list")} className="space-y-2">
                    <h2 className="font-semibold">{t("dossiers.list")}</h2>
                    {list.isLoading && <p>{t("dossiers.loading")}</p>}
                    {list.isError && (
                        <p role="alert">{apiErrorToMessage(list.error, t)}</p>
                    )}
                    {!list.isLoading && !list.data?.items.length && (
                        <p className="text-sm text-muted-foreground">
                            {t("dossiers.empty")}
                        </p>
                    )}
                    {list.data?.items.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            aria-current={
                                selectedId === item.id ? "page" : undefined
                            }
                            onClick={() => choose(item.id)}
                            className="w-full rounded-lg border p-3 text-left hover:bg-accent aria-[current=page]:border-primary"
                        >
                            <span className="block font-medium">
                                {item.title}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                                {t(`dossiers.workspace.${item.workspace}`)} ·{" "}
                                {t("dossiers.version", {
                                    version: item.version,
                                })}
                            </span>
                        </button>
                    ))}
                    {list.data && list.data.total > 500 && (
                        <div className="flex items-center gap-2 text-sm">
                            <Button
                                type="button"
                                variant="outline"
                                disabled={listOffset === 0}
                                onClick={() =>
                                    setListOffset(Math.max(0, listOffset - 500))
                                }
                            >
                                {t("dossiers.previous")}
                            </Button>
                            <span>
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
                                disabled={listOffset + 500 >= list.data.total}
                                onClick={() => setListOffset(listOffset + 500)}
                            >
                                {t("dossiers.next")}
                            </Button>
                        </div>
                    )}
                </aside>
                <main className="space-y-6">
                    {selectedId && detail.isLoading && (
                        <p>{t("dossiers.loading")}</p>
                    )}
                    {selectedId && detail.isError && (
                        <p role="alert">{apiErrorToMessage(detail.error, t)}</p>
                    )}
                    {!draft && !selectedId && (
                        <p className="text-muted-foreground">
                            {t("dossiers.select")}
                        </p>
                    )}
                    {draft && (
                        <form
                            className="space-y-6"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void save();
                            }}
                        >
                            <div className="flex flex-wrap gap-2">
                                <Button type="submit" disabled={busy}>
                                    <Save className="mr-2 size-4" />
                                    {t("dossiers.save")}
                                </Button>
                                {selectedId && (
                                    <>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() =>
                                                void exportJson(selectedId)
                                            }
                                        >
                                            <Download className="mr-2 size-4" />
                                            {t("dossiers.exportOne")}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="destructive"
                                            disabled={busy}
                                            onClick={() => void remove()}
                                        >
                                            <Trash2 className="mr-2 size-4" />
                                            {t("dossiers.delete")}
                                        </Button>
                                    </>
                                )}
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-1">
                                    <Label htmlFor="dossier-title">
                                        {t("dossiers.field.title")}
                                    </Label>
                                    <Input
                                        id="dossier-title"
                                        required
                                        value={draft.title}
                                        onChange={(event) =>
                                            edit({ title: event.target.value })
                                        }
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label htmlFor="dossier-workspace">
                                        {t("dossiers.field.workspace")}
                                    </Label>
                                    <select
                                        id="dossier-workspace"
                                        className="h-10 w-full rounded-lg border bg-background px-3"
                                        value={draft.workspace}
                                        onChange={(event) =>
                                            edit({
                                                workspace: event.target
                                                    .value as AnalysisWorkspace,
                                            })
                                        }
                                    >
                                        {(
                                            [
                                                "budgeting",
                                                "portfolio",
                                                "research",
                                                "cross-workspace",
                                            ] as const
                                        ).map((value) => (
                                            <option key={value} value={value}>
                                                {t(
                                                    `dossiers.workspace.${value}`,
                                                )}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="dossier-question">
                                    {t("dossiers.field.question")}
                                </Label>
                                <Textarea
                                    id="dossier-question"
                                    required
                                    value={draft.question}
                                    onChange={(event) =>
                                        edit({ question: event.target.value })
                                    }
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="dossier-thesis">
                                    {t("dossiers.field.thesis")}
                                </Label>
                                <Textarea
                                    id="dossier-thesis"
                                    value={draft.userThesis}
                                    onChange={(event) =>
                                        edit({ userThesis: event.target.value })
                                    }
                                />
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <LinesField
                                    label={t("dossiers.field.assumptions")}
                                    value={draft.assumptions}
                                    onChange={(assumptions) =>
                                        edit({ assumptions })
                                    }
                                />
                                <LinesField
                                    label={t("dossiers.field.openQuestions")}
                                    value={draft.openQuestions}
                                    onChange={(openQuestions) =>
                                        edit({ openQuestions })
                                    }
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="dossier-conclusion">
                                    {t("dossiers.field.conclusion")}
                                </Label>
                                <Textarea
                                    id="dossier-conclusion"
                                    value={draft.conclusion}
                                    onChange={(event) =>
                                        edit({ conclusion: event.target.value })
                                    }
                                    rows={5}
                                />
                            </div>
                            <div className="space-y-1">
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
                                                event.target.value || null,
                                        })
                                    }
                                />
                            </div>
                            <section className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-lg font-semibold">
                                        {t("dossiers.evidence")}
                                    </h2>
                                    <Button
                                        type="button"
                                        variant="outline"
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
                                        {t("dossiers.addEvidence")}
                                    </Button>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    {t("dossiers.evidenceHint")}
                                </p>
                                {draft.evidence.map((item, index) => (
                                    <fieldset
                                        key={item.id}
                                        className="space-y-3 rounded-lg border p-4"
                                    >
                                        <legend className="px-1 font-medium">
                                            {t("dossiers.evidenceNumber", {
                                                number: index + 1,
                                            })}{" "}
                                            ·{" "}
                                            {t(
                                                `dossiers.origin.${item.origin}`,
                                            )}
                                        </legend>
                                        <div className="flex justify-end">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                onClick={() =>
                                                    edit({
                                                        evidence:
                                                            draft.evidence.filter(
                                                                (entry) =>
                                                                    entry.id !==
                                                                    item.id,
                                                            ),
                                                    })
                                                }
                                            >
                                                {t("dossiers.removeEvidence")}
                                            </Button>
                                        </div>
                                        <div className="space-y-1">
                                            <Label
                                                htmlFor={`origin-${item.id}`}
                                            >
                                                {t("dossiers.field.origin")}
                                            </Label>
                                            <select
                                                id={`origin-${item.id}`}
                                                className="h-10 w-full rounded-lg border bg-background px-3"
                                                value={item.origin}
                                                onChange={(event) =>
                                                    updateEvidence(item.id, {
                                                        origin: event.target
                                                            .value as EvidenceOrigin,
                                                    })
                                                }
                                            >
                                                <option value="user">
                                                    {t("dossiers.origin.user")}
                                                </option>
                                                <option value="ai-draft">
                                                    {t(
                                                        "dossiers.origin.ai-draft",
                                                    )}
                                                </option>
                                            </select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label htmlFor={`claim-${item.id}`}>
                                                {t("dossiers.field.claim")}
                                            </Label>
                                            <Textarea
                                                id={`claim-${item.id}`}
                                                required
                                                value={item.claim}
                                                onChange={(event) =>
                                                    updateEvidence(item.id, {
                                                        claim: event.target
                                                            .value,
                                                    })
                                                }
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <Label
                                                htmlFor={`stance-${item.id}`}
                                            >
                                                {t("dossiers.field.stance")}
                                            </Label>
                                            <select
                                                id={`stance-${item.id}`}
                                                className="h-10 w-full rounded-lg border bg-background px-3"
                                                value={item.stance}
                                                onChange={(event) =>
                                                    updateEvidence(item.id, {
                                                        stance: event.target
                                                            .value as EvidenceStance,
                                                    })
                                                }
                                            >
                                                {(
                                                    [
                                                        "support",
                                                        "oppose",
                                                        "context",
                                                    ] as const
                                                ).map((stance) => (
                                                    <option
                                                        key={stance}
                                                        value={stance}
                                                    >
                                                        {t(
                                                            `dossiers.stance.${stance}`,
                                                        )}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label
                                                htmlFor={`source-document-${item.id}`}
                                            >
                                                {t("dossiers.field.document")}
                                            </Label>
                                            <select
                                                id={`source-document-${item.id}`}
                                                className="h-10 w-full rounded-lg border bg-background px-3"
                                                value={
                                                    item.source.documentId ?? ""
                                                }
                                                onChange={(event) => {
                                                    const document =
                                                        documents.data?.find(
                                                            (candidate) =>
                                                                candidate.id ===
                                                                event.target
                                                                    .value,
                                                        );
                                                    const {
                                                        documentId: _documentId,
                                                        documentVersion:
                                                            _documentVersion,
                                                        passageOrdinal:
                                                            _passageOrdinal,
                                                        contentSha256:
                                                            _contentSha256,
                                                        ...rest
                                                    } = item.source;
                                                    updateEvidence(item.id, {
                                                        source: document
                                                            ? {
                                                                  ...rest,
                                                                  documentId:
                                                                      document.id,
                                                                  documentVersion:
                                                                      document.version,
                                                                  title:
                                                                      rest.title ||
                                                                      document.title,
                                                              }
                                                            : rest,
                                                    });
                                                }}
                                            >
                                                <option value="">
                                                    {t("dossiers.noDocument")}
                                                </option>
                                                {documents.data
                                                    ?.filter(
                                                        (document) =>
                                                            document.extractionStatus ===
                                                            "ready",
                                                    )
                                                    .map((document) => (
                                                        <option
                                                            key={document.id}
                                                            value={document.id}
                                                        >
                                                            {document.title}
                                                        </option>
                                                    ))}
                                            </select>
                                            {documents.isError && (
                                                <p role="alert">
                                                    {t(
                                                        "dossiers.documentsError",
                                                    )}
                                                </p>
                                            )}
                                            {item.source.documentId &&
                                                !documents.data?.some(
                                                    (document) =>
                                                        document.id ===
                                                        item.source.documentId,
                                                ) && (
                                                    <p className="text-sm text-amber-600">
                                                        {t(
                                                            "dossiers.documentUnavailable",
                                                        )}
                                                    </p>
                                                )}
                                        </div>
                                        <div className="grid gap-3 md:grid-cols-2">
                                            <div className="space-y-1">
                                                <Label
                                                    htmlFor={`source-title-${item.id}`}
                                                >
                                                    {t(
                                                        "dossiers.field.sourceTitle",
                                                    )}
                                                </Label>
                                                <Input
                                                    id={`source-title-${item.id}`}
                                                    required
                                                    value={item.source.title}
                                                    onChange={(event) =>
                                                        updateEvidence(
                                                            item.id,
                                                            {
                                                                source: {
                                                                    ...item.source,
                                                                    title: event
                                                                        .target
                                                                        .value,
                                                                },
                                                            },
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <Label
                                                    htmlFor={`source-ref-${item.id}`}
                                                >
                                                    {t(
                                                        "dossiers.field.sourceReference",
                                                    )}
                                                </Label>
                                                <Input
                                                    id={`source-ref-${item.id}`}
                                                    required
                                                    value={
                                                        item.source.reference
                                                    }
                                                    onChange={(event) =>
                                                        updateEvidence(
                                                            item.id,
                                                            {
                                                                source: {
                                                                    ...item.source,
                                                                    reference:
                                                                        event
                                                                            .target
                                                                            .value,
                                                                },
                                                            },
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <Label
                                                    htmlFor={`source-date-${item.id}`}
                                                >
                                                    {t(
                                                        "dossiers.field.sourceDate",
                                                    )}
                                                </Label>
                                                <Input
                                                    id={`source-date-${item.id}`}
                                                    type="date"
                                                    value={
                                                        item.source
                                                            .sourceDate ?? ""
                                                    }
                                                    onChange={(event) =>
                                                        updateEvidence(
                                                            item.id,
                                                            {
                                                                source: {
                                                                    ...item.source,
                                                                    sourceDate:
                                                                        event
                                                                            .target
                                                                            .value ||
                                                                        null,
                                                                },
                                                            },
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <Label
                                                    htmlFor={`source-accessed-${item.id}`}
                                                >
                                                    {t(
                                                        "dossiers.field.accessedAt",
                                                    )}
                                                </Label>
                                                <Input
                                                    id={`source-accessed-${item.id}`}
                                                    type="datetime-local"
                                                    value={
                                                        item.source.accessedAt?.slice(
                                                            0,
                                                            16,
                                                        ) ?? ""
                                                    }
                                                    onChange={(event) =>
                                                        updateEvidence(
                                                            item.id,
                                                            {
                                                                source: {
                                                                    ...item.source,
                                                                    accessedAt:
                                                                        event
                                                                            .target
                                                                            .value
                                                                            ? new Date(
                                                                                  event
                                                                                      .target
                                                                                      .value,
                                                                              ).toISOString()
                                                                            : null,
                                                                },
                                                            },
                                                        )
                                                    }
                                                />
                                            </div>
                                        </div>
                                        <div className="space-y-1">
                                            <Label htmlFor={`notes-${item.id}`}>
                                                {t("dossiers.field.notes")}
                                            </Label>
                                            <Textarea
                                                id={`notes-${item.id}`}
                                                value={item.notes}
                                                onChange={(event) =>
                                                    updateEvidence(item.id, {
                                                        notes: event.target
                                                            .value,
                                                    })
                                                }
                                            />
                                        </div>
                                        {(item.source.documentId ||
                                            item.source.contentSha256) && (
                                            <p className="break-all text-xs text-muted-foreground">
                                                {t("dossiers.documentAnchor", {
                                                    id:
                                                        item.source
                                                            .documentId ?? "—",
                                                    version:
                                                        item.source
                                                            .documentVersion ??
                                                        "—",
                                                    passage:
                                                        item.source
                                                            .passageOrdinal ??
                                                        "—",
                                                    hash:
                                                        item.source
                                                            .contentSha256 ??
                                                        "—",
                                                })}
                                            </p>
                                        )}
                                    </fieldset>
                                ))}
                            </section>
                            <section className="space-y-3">
                                <h2 className="text-lg font-semibold">
                                    {t("dossiers.links")}
                                </h2>
                                <p className="text-sm text-muted-foreground">
                                    {t("dossiers.linksHint")}
                                </p>
                                {detail.data?.linkDetails
                                    ?.filter(
                                        (entry) => entry.status === "deleted",
                                    )
                                    .map((entry) => (
                                        <p
                                            key={`${entry.kind}-${entry.historicalId}`}
                                            className="rounded-md border border-amber-500/50 p-2 text-sm"
                                        >
                                            {t("dossiers.deletedLink", {
                                                label: entry.labelSnapshot,
                                                id: entry.historicalId,
                                            })}
                                        </p>
                                    ))}
                                <div className="grid gap-4 lg:grid-cols-3">
                                    <fieldset className="max-h-56 space-y-2 overflow-auto rounded-lg border p-3">
                                        <legend>
                                            {t("dossiers.linkCategories")}
                                        </legend>
                                        {categories.isError && (
                                            <p role="alert">
                                                {t("dossiers.linksError")}
                                            </p>
                                        )}
                                        {categories.data?.items.map((item) => (
                                            <label
                                                key={item.id}
                                                className="flex gap-2 text-sm"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={draft.links.categoryIds.includes(
                                                        item.id,
                                                    )}
                                                    onChange={() =>
                                                        toggleLink(
                                                            "categoryIds",
                                                            item.id,
                                                        )
                                                    }
                                                />
                                                <span>
                                                    {item.path.join(" / ")}
                                                </span>
                                            </label>
                                        ))}
                                    </fieldset>
                                    <fieldset className="max-h-56 space-y-2 overflow-auto rounded-lg border p-3">
                                        <legend>
                                            {t("dossiers.linkInvestments")}
                                        </legend>
                                        {investments.isError && (
                                            <p role="alert">
                                                {t("dossiers.linksError")}
                                            </p>
                                        )}
                                        {investments.data?.items.map((item) => (
                                            <label
                                                key={item.id}
                                                className="flex gap-2 text-sm"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={draft.links.investmentIds.includes(
                                                        item.id,
                                                    )}
                                                    onChange={() =>
                                                        toggleLink(
                                                            "investmentIds",
                                                            item.id,
                                                        )
                                                    }
                                                />
                                                <span>{item.name}</span>
                                            </label>
                                        ))}
                                    </fieldset>
                                    <fieldset className="max-h-56 space-y-2 overflow-auto rounded-lg border p-3">
                                        <legend>
                                            {t("dossiers.linkAnalyses")}
                                        </legend>
                                        {analyses.isError && (
                                            <p role="alert">
                                                {t("dossiers.linksError")}
                                            </p>
                                        )}
                                        {analyses.data?.map((item) => (
                                            <label
                                                key={item.id}
                                                className="flex gap-2 text-sm"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={draft.links.savedAnalysisIds.includes(
                                                        item.id,
                                                    )}
                                                    onChange={() =>
                                                        toggleLink(
                                                            "savedAnalysisIds",
                                                            item.id,
                                                        )
                                                    }
                                                />
                                                <span>{item.name}</span>
                                            </label>
                                        ))}
                                    </fieldset>
                                </div>
                            </section>
                            {selectedId && (
                                <section className="space-y-2">
                                    <h2 className="text-lg font-semibold">
                                        {t("dossiers.history")}
                                    </h2>
                                    {history.isError && (
                                        <p role="alert">
                                            {t("dossiers.historyError")}
                                        </p>
                                    )}
                                    {history.data?.map((entry) => (
                                        <div
                                            key={entry.version}
                                            className="flex items-center justify-between rounded-lg border p-3"
                                        >
                                            <div className="min-w-0">
                                                <p>
                                                    {t("dossiers.version", {
                                                        version: entry.version,
                                                    })}{" "}
                                                    ·{" "}
                                                    {new Date(
                                                        entry.createdAt,
                                                    ).toLocaleString()}
                                                </p>
                                                <p className="truncate text-sm text-muted-foreground">
                                                    {entry.snapshot
                                                        .conclusion ||
                                                        t(
                                                            "dossiers.noConclusion",
                                                        )}
                                                </p>
                                            </div>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                disabled={
                                                    busy ||
                                                    entry.version ===
                                                        detail.data?.version
                                                }
                                                onClick={() =>
                                                    void restore(entry.version)
                                                }
                                            >
                                                <RotateCcw className="mr-2 size-4" />
                                                {t("dossiers.restore")}
                                            </Button>
                                        </div>
                                    ))}
                                </section>
                            )}
                        </form>
                    )}
                </main>
            </div>
        </PageShell>
    );
}
