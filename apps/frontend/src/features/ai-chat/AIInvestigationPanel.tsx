import { InvestigationPrivacySummary } from "./InvestigationPrivacySummary";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { FileText, Paperclip, Trash2 } from "lucide-react";
import { apiClient } from "@/lib/api";
import type {
    AiAnswer,
    AiInvestigation,
    InvestigationInput,
    OpenAiResearchModel,
    ResearchDocument,
} from "@/lib/api/aiResearch";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    Disclosure,
    DisclosureContent,
    DisclosureSummary,
} from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
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
import { Textarea } from "@/components/ui/textarea";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { resolveOpenAiModel } from "@/features/ai-chat/openAiModelSelection";
import { useAiResearchStatus } from "@/hooks/useAiResearchStatus";
import { resolveAnalysisPreferences } from "@/lib/analysisPreferences";

const EMPTY_OPENAI_MODELS: OpenAiResearchModel[] = [];

const codeBlockClass =
    "max-h-40 overflow-auto rounded-card corner-continuous border border-border/50 bg-background/60 p-3 type-footnote leading-snug text-foreground/80";
function EvidenceAnswer({ answer }: { answer: AiAnswer }) {
    const { t } = useLanguage();
    const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
        null,
    );
    const evidence = useMemo(
        () => new Map(answer.evidence.map((item) => [item.id, item])),
        [answer.evidence],
    );
    const selectedEvidence = selectedEvidenceId
        ? evidence.get(selectedEvidenceId)
        : undefined;
    const section = (
        label: string,
        items: Array<{ text: string; evidenceIds: string[] }>,
    ) =>
        items.length ? (
            <section className="space-y-1">
                <h4 className="type-headline">{label}</h4>
                <ul className="list-disc space-y-1 pl-5 type-body">
                    {items.map((item, index) => (
                        <li key={`${label}-${index}`}>
                            {item.text}
                            {item.evidenceIds.map((id) => (
                                <Button
                                    key={id}
                                    type="button"
                                    variant="link"
                                    size="sm"
                                    className="ml-1 h-auto px-0 py-0"
                                    title={
                                        evidence.get(id)?.excerpt ?? undefined
                                    }
                                    onClick={() => setSelectedEvidenceId(id)}
                                >
                                    {evidence.get(id)?.label ?? id}
                                </Button>
                            ))}
                        </li>
                    ))}
                </ul>
            </section>
        ) : null;
    return (
        <Card data-testid="ai-evidence-answer">
            <CardContent variant="compact" className="space-y-3">
                <div className="flex flex-wrap justify-between gap-2 type-footnote text-label-secondary">
                    <span>{t(`aiResearch.status.${answer.status}`)}</span>
                    <span>
                        {answer.language.toUpperCase()} · {answer.depth}
                    </span>
                </div>
                <p className="type-body">{answer.summary}</p>
                {section(t("aiResearch.facts"), answer.facts)}
                {section(t("aiResearch.calculations"), answer.calculations)}
                {section(
                    t("aiResearch.interpretations"),
                    answer.interpretations,
                )}
                {answer.assumptions.length > 0 && (
                    <p className="type-footnote text-label-secondary">
                        <span className="font-medium text-foreground">
                            {t("aiResearch.assumptions")}:
                        </span>{" "}
                        {answer.assumptions.join("; ")}
                    </p>
                )}
                {answer.missingInformation.length > 0 && (
                    <p className="type-footnote text-warning">
                        <span className="font-medium">
                            {t("aiResearch.missing")}:
                        </span>{" "}
                        {answer.missingInformation.join("; ")}
                    </p>
                )}
                {answer.analysisReference && (
                    <Button asChild size="sm" variant="outline">
                        <Link
                            to={`/analysis?savedAnalysis=${encodeURIComponent(answer.analysisReference.id)}`}
                        >
                            {t("aiResearch.openAnalysis")}
                        </Link>
                    </Button>
                )}
                {selectedEvidence && (
                    <Card asChild>
                        <aside>
                            <CardContent
                                variant="compact"
                                className="space-y-2 type-footnote"
                            >
                                <p className="type-headline">
                                    {selectedEvidence.label}
                                </p>
                                <p className="whitespace-pre-wrap text-label-secondary">
                                    {selectedEvidence.excerpt}
                                </p>
                                {selectedEvidence.kind === "web" &&
                                /^https:\/\//.test(
                                    selectedEvidence.locator ?? "",
                                ) ? (
                                    <a
                                        className="inline-block break-all text-primary underline underline-offset-4 decoration-primary/50 focus-ring rounded-chip"
                                        href={selectedEvidence.locator}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {selectedEvidence.locator}
                                    </a>
                                ) : (
                                    <code className="block break-all text-label-secondary">
                                        {selectedEvidence.locator}
                                    </code>
                                )}
                            </CardContent>
                        </aside>
                    </Card>
                )}
            </CardContent>
        </Card>
    );
}

export function AIInvestigationPanel() {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: aiResearchStatus } = useAiResearchStatus();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const [question, setQuestion] = useState("");
    const questionRef = useRef<HTMLTextAreaElement>(null);
    const documentInputRef = useRef<HTMLInputElement>(null);
    const [depthOverride, setDepthOverride] = useState<
        "quick" | "detailed" | null
    >(null);
    const [route, setRoute] = useState<"local" | "openai-api">("local");
    const [openAiModelOverride, setOpenAiModelOverride] = useState<
        string | null
    >(null);
    const [disclosureMode, setDisclosureMode] = useState<
        "cloud-plan-public" | "selected-summary" | "cloud-synthesis-selected"
    >("cloud-plan-public");
    const [selectedSummary, setSelectedSummary] = useState("");
    const [selectedEvidence, setSelectedEvidence] = useState("");
    const [researchMode, setResearchMode] = useState<
        "local-only" | "public-providers" | "public-web"
    >("local-only");
    const [publicWebQuery, setPublicWebQuery] = useState("");
    const [publicQuestion, setPublicQuestion] = useState("");
    const [publicSymbols, setPublicSymbols] = useState("");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [clarification, setClarification] = useState("");
    const [job, setJob] = useState<AiInvestigation | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<Awaited<
        ReturnType<typeof apiClient.previewAiDisclosure>
    > | null>(null);
    const [grantId, setGrantId] = useState<string | null>(null);
    const [recordCount, setRecordCount] = useState<number | null>(null);
    const [disclosureRecords, setDisclosureRecords] = useState<
        Array<Record<string, unknown>>
    >([]);
    const [disclosureGrants, setDisclosureGrants] = useState<
        Array<Record<string, unknown>>
    >([]);
    const [documents, setDocuments] = useState<ResearchDocument[]>([]);
    const openAiEnabled = Boolean(aiResearchStatus?.openai.enabled);
    const resolvedPreferences = resolveAnalysisPreferences({ appSettings });
    const depth = depthOverride ?? resolvedPreferences.answerDepth;
    const openAiModels = aiResearchStatus?.openai.models ?? EMPTY_OPENAI_MODELS;
    const openAiServerDefault = aiResearchStatus?.openai.model ?? "";
    const openAiModel = resolveOpenAiModel({
        override: openAiModelOverride,
        userDefault: appSettings.openAiDefaultModel,
        serverDefault: openAiServerDefault,
        models: openAiModels,
    });
    const selectedOpenAiModel = openAiModels.find(
        (model) => model.id === openAiModel,
    );
    const failureMessage = (cause: unknown) =>
        cause instanceof Error ? cause.message : t("aiResearch.failed");
    const input = (): InvestigationInput => ({
        question: question.trim(),
        route,
        researchMode,
        publicQuestion:
            route === "openai-api" && disclosureMode === "cloud-plan-public"
                ? publicQuestion.trim()
                : null,
        publicWebQuery:
            researchMode === "public-web" ? publicWebQuery.trim() : null,
        publicSymbols:
            researchMode === "public-providers"
                ? publicSymbols
                      .split(",")
                      .map((value) => value.trim().toUpperCase())
                      .filter(Boolean)
                      .slice(0, 3)
                : [],
        publicMacroQueries: [],
        clarification: null,
        model: route === "openai-api" ? openAiModel || null : null,
        depth,
        language: language === "nl" ? "nl" : "en",
        scope: {
            workspaces: ["cross-workspace"],
            accountIds: [],
            investmentIds: [],
            dateFrom: dateFrom || null,
            dateTo: dateTo || null,
            currency: resolvedPreferences.currency,
            constraints: resolvedPreferences.benchmark
                ? [`benchmark:${resolvedPreferences.benchmark}`]
                : [],
        },
        grantId: null,
        selectedSummary:
            route === "openai-api" && disclosureMode === "selected-summary"
                ? selectedSummary.trim()
                : null,
        selectedEvidence:
            route === "openai-api" &&
            disclosureMode === "cloud-synthesis-selected"
                ? selectedEvidence.trim()
                : null,
        referenceScopeId: null,
        savedAnalysisId: null,
    });
    useEffect(() => {
        void apiClient
            .listResearchDocuments()
            .then(setDocuments)
            .catch(() => {});
    }, []);
    useEffect(() => {
        if (
            !job ||
            ["completed", "failed", "cancelled", "partial", "waiting"].includes(
                job.state,
            )
        )
            return;
        const timer = window.setInterval(
            () =>
                void apiClient
                    .getInvestigation(job.id)
                    .then(setJob)
                    .catch(() => {}),
            1200,
        );
        return () => window.clearInterval(timer);
    }, [job]);
    useEffect(() => {
        setPreview(null);
    }, [
        dateFrom,
        dateTo,
        depth,
        disclosureMode,
        language,
        openAiModel,
        publicSymbols,
        publicQuestion,
        publicWebQuery,
        researchMode,
        route,
        selectedEvidence,
        selectedSummary,
    ]);
    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            let request = input();
            if (route === "openai-api") {
                if (!preview) {
                    setPreview(await apiClient.previewAiDisclosure(request));
                    return;
                }
                const grant = await apiClient.createAiDisclosureGrant({
                    route: "openai-api",
                    mode: disclosureMode,
                    purpose:
                        disclosureMode === "cloud-synthesis-selected"
                            ? "Synthesize an answer from this inspected selected evidence"
                            : "Plan this inspected investigation question",
                    previewHash: preview.payloadSha256,
                    allowedFields: preview.fieldManifest,
                    maxRequests: 3,
                    maxInputCharacters: Math.max(100, preview.payloadBytes * 2),
                    maxOutputTokens: depth === "detailed" ? 7200 : 2700,
                    maxCostMicros: 2_000_000,
                    maxDisclosureUnits: preview.disclosureUnits.length,
                    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                    retainExactPayload: false,
                });
                setGrantId(grant.id);
                request = { ...preview.outboundRequest, grantId: grant.id };
            }
            setJob(await apiClient.createInvestigation(request));
        } catch (cause) {
            setError(failureMessage(cause));
        } finally {
            setBusy(false);
        }
    };
    const uploadDocument = (file: File) => {
        setBusy(true);
        void apiClient
            .uploadResearchDocument(file)
            .then((document) => setDocuments((items) => [document, ...items]))
            .catch((cause) => setError(failureMessage(cause)))
            .finally(() => setBusy(false));
    };
    const deleteDocument = async (document: ResearchDocument) => {
        const accepted = await confirm({
            title: t("aiResearch.deleteDocument"),
            description: t("aiResearch.deleteDocumentConfirm", {
                name: document.title,
            }),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            variant: "destructive",
        });
        if (!accepted) return;
        void apiClient
            .deleteResearchDocument(document.id)
            .then(() =>
                setDocuments((items) =>
                    items.filter((item) => item.id !== document.id),
                ),
            )
            .catch((cause) => setError(failureMessage(cause)));
    };
    const runDisabled =
        busy ||
        !question.trim() ||
        (researchMode === "public-web" && !publicWebQuery.trim()) ||
        (researchMode === "public-providers" && !publicSymbols.trim()) ||
        (route === "openai-api" && (!openAiEnabled || !openAiModel)) ||
        (route === "openai-api" &&
            disclosureMode === "cloud-plan-public" &&
            !publicQuestion.trim()) ||
        (route === "openai-api" &&
            disclosureMode === "selected-summary" &&
            !selectedSummary.trim()) ||
        (route === "openai-api" &&
            disclosureMode === "cloud-synthesis-selected" &&
            !selectedEvidence.trim());
    const settingsSummary = [
        t(route === "local" ? "aiResearch.localModel" : "aiResearch.openAi"),
        t(depth === "quick" ? "aiResearch.quick" : "aiResearch.detailed"),
        t(
            researchMode === "local-only"
                ? "aiResearch.localOnly"
                : researchMode === "public-web"
                  ? "aiResearch.publicWeb"
                  : "aiResearch.publicProviders",
        ),
    ].join(" · ");
    return (
        <section
            className="space-y-4 p-4 sm:p-5"
            aria-labelledby="ai-investigation-heading"
        >
            <h2 id="ai-investigation-heading" className="type-title-3">
                {t("aiResearch.title")}
            </h2>
            <div className="space-y-3">
                <Textarea
                    ref={questionRef}
                    aria-label={t("aiResearch.question")}
                    className="min-h-28 resize-y"
                    value={question}
                    onChange={(event) => {
                        setQuestion(event.target.value);
                        setPreview(null);
                    }}
                    placeholder={t("aiResearch.question")}
                />
                {!question && (
                    <div
                        className="flex flex-wrap gap-2"
                        aria-label={t("aiResearch.questionIdeas")}
                    >
                        {["spending", "portfolio"].map((topic) => (
                            <Button
                                key={topic}
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-auto whitespace-normal py-2 text-left"
                                onClick={() => {
                                    setQuestion(
                                        t(
                                            `aiResearch.starter.${topic}.question`,
                                        ),
                                    );
                                    setPreview(null);
                                    questionRef.current?.focus();
                                }}
                            >
                                {t(`aiResearch.starter.${topic}.label`)}
                            </Button>
                        ))}
                    </div>
                )}
                <Card asChild className="rounded-none border-x-0 border-t-0 bg-transparent shadow-none">
                    <Disclosure>
                        <DisclosureSummary
                            padded
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                        >
                            <span>{t("aiResearch.configure")}</span>
                            <span className="type-footnote font-normal text-label-secondary">
                                {settingsSummary}
                            </span>
                        </DisclosureSummary>
                        <DisclosureContent className="grid gap-4 pt-0 sm:grid-cols-2">
                            <SegmentedControl
                                label={t("aiResearch.route")}
                                wrapperClassName="space-y-1.5"
                                className="w-full"
                                value={route}
                                onValueChange={(value) => {
                                    setRoute(value as typeof route);
                                    setPreview(null);
                                }}
                            >
                                <SegmentedControlItem value="local">
                                    {t("aiResearch.localModel")}
                                </SegmentedControlItem>
                                <SegmentedControlItem
                                    value="openai-api"
                                    disabled={!openAiEnabled}
                                >
                                    {t("aiResearch.openAi")}
                                </SegmentedControlItem>
                            </SegmentedControl>
                            <SegmentedControl
                                label={t("aiResearch.depth")}
                                wrapperClassName="space-y-1.5"
                                className="w-full"
                                value={depth}
                                onValueChange={(value) =>
                                    setDepthOverride(
                                        value as "quick" | "detailed",
                                    )
                                }
                            >
                                <SegmentedControlItem value="quick">
                                    {t("aiResearch.quick")}
                                </SegmentedControlItem>
                                <SegmentedControlItem value="detailed">
                                    {t("aiResearch.detailed")}
                                </SegmentedControlItem>
                            </SegmentedControl>
                            <SegmentedControl
                                label={t("aiResearch.researchMode")}
                                wrapperClassName="space-y-1.5 sm:col-span-2"
                                className="w-full"
                                value={researchMode}
                                disabled={
                                    route === "openai-api" &&
                                    disclosureMode ===
                                        "cloud-synthesis-selected"
                                }
                                onValueChange={(value) =>
                                    setResearchMode(
                                        value as typeof researchMode,
                                    )
                                }
                            >
                                <SegmentedControlItem value="local-only">
                                    {t("aiResearch.localOnly")}
                                </SegmentedControlItem>
                                <SegmentedControlItem value="public-providers">
                                    {t("aiResearch.publicProviders")}
                                </SegmentedControlItem>
                                <SegmentedControlItem value="public-web">
                                    {t("aiResearch.publicWeb")}
                                </SegmentedControlItem>
                            </SegmentedControl>
                        </DisclosureContent>
                    </Disclosure>
                </Card>
            </div>
            {researchMode === "public-web" && (
                <div className="space-y-1.5">
                    <Label htmlFor="ai-public-web-query">
                        {t("aiResearch.publicWebQuery")}
                    </Label>
                    <Input
                        id="ai-public-web-query"
                        value={publicWebQuery}
                        onChange={(event) =>
                            setPublicWebQuery(event.target.value)
                        }
                        placeholder={t("aiResearch.publicWebQueryPlaceholder")}
                    />
                    <p className="type-footnote text-label-secondary">
                        {t("aiResearch.publicWebQueryHelp")}
                    </p>
                </div>
            )}
            {researchMode === "public-providers" && (
                <div className="space-y-1.5">
                    <Label htmlFor="ai-public-symbols">
                        {t("aiResearch.publicSymbols")}
                    </Label>
                    <Input
                        id="ai-public-symbols"
                        value={publicSymbols}
                        onChange={(event) =>
                            setPublicSymbols(event.target.value)
                        }
                        placeholder={t("aiResearch.publicSymbolsPlaceholder")}
                    />
                    <p className="type-footnote text-label-secondary">
                        {t("aiResearch.publicSymbolsHelp")}
                    </p>
                </div>
            )}
            <Card asChild className="rounded-none border-x-0 border-t-0 bg-transparent shadow-none">
                <Disclosure>
                    <DisclosureSummary
                        padded
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                    >
                        <span>{t("aiResearch.evidenceOptions")}</span>
                        <span className="type-footnote font-normal text-label-secondary">
                            {t("aiResearch.documentCount", {
                                count: documents.length,
                            })}
                            {(dateFrom || dateTo) &&
                                ` · ${dateFrom || "…"} – ${dateTo || "…"}`}
                        </span>
                    </DisclosureSummary>
                    <DisclosureContent className="space-y-4 pt-0">
                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                    documentInputRef.current?.click()
                                }
                            >
                                <Paperclip className="h-4 w-4" aria-hidden />
                                {t("aiResearch.addDocument")}
                            </Button>
                            <input
                                ref={documentInputRef}
                                className="hidden"
                                type="file"
                                accept="text/plain,text/markdown,text/html,.md,.txt,.html"
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) uploadDocument(file);
                                }}
                            />
                            <span className="type-footnote text-label-secondary">
                                {t("aiResearch.documentCount", {
                                    count: documents.length,
                                })}
                            </span>
                        </div>
                        {documents.length > 0 && (
                            <List>
                                {documents.map((document) => (
                                    <ListRow
                                        key={document.id}
                                        leading={<FileText aria-hidden />}
                                        title={document.title}
                                        subtitle={document.extractionStatus}
                                        trailing={
                                            <Button
                                                type="button"
                                                size="icon-sm"
                                                variant="ghost"
                                                className="icon-touch-target text-destructive hover:text-destructive"
                                                aria-label={`${t("aiResearch.deleteDocument")}: ${document.title}`}
                                                onClick={() =>
                                                    void deleteDocument(
                                                        document,
                                                    )
                                                }
                                            >
                                                <Trash2
                                                    className="h-4 w-4"
                                                    aria-hidden
                                                />
                                            </Button>
                                        }
                                    />
                                ))}
                            </List>
                        )}
                        <p className="type-footnote text-label-secondary">
                            {t("aiResearch.effectivePreferences", {
                                currency: resolvedPreferences.currency,
                                benchmark:
                                    resolvedPreferences.benchmark ??
                                    t("aiResearch.noBenchmark"),
                            })}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="ai-date-from">
                                    {t("aiResearch.dateFrom")}
                                </Label>
                                <Input
                                    id="ai-date-from"
                                    type="date"
                                    value={dateFrom}
                                    onChange={(event) =>
                                        setDateFrom(event.target.value)
                                    }
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="ai-date-to">
                                    {t("aiResearch.dateTo")}
                                </Label>
                                <Input
                                    id="ai-date-to"
                                    type="date"
                                    value={dateTo}
                                    onChange={(event) =>
                                        setDateTo(event.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </DisclosureContent>
                </Disclosure>
            </Card>
            {route === "openai-api" && (
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="ai-openai-model">
                            {t("aiResearch.openAiModel")}
                        </Label>
                        <Select
                            value={openAiModel || undefined}
                            disabled={
                                !openAiEnabled || openAiModels.length === 0
                            }
                            onValueChange={(value) => {
                                setOpenAiModelOverride(value);
                                setPreview(null);
                            }}
                        >
                            <SelectTrigger id="ai-openai-model">
                                <SelectValue
                                    placeholder={t("aiResearch.noOpenAiModels")}
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {openAiModels.map((model) => (
                                    <SelectItem key={model.id} value={model.id}>
                                        {model.label} ({model.id})
                                        {model.isDefault
                                            ? ` — ${t("aiResearch.defaultModel")}`
                                            : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {selectedOpenAiModel && (
                            <p className="type-footnote text-label-secondary">
                                {t("aiResearch.modelRates", {
                                    input: (
                                        selectedOpenAiModel.inputMicrosPerMillion /
                                        1_000_000
                                    ).toLocaleString(language, {
                                        maximumFractionDigits: 6,
                                    }),
                                    output: (
                                        selectedOpenAiModel.outputMicrosPerMillion /
                                        1_000_000
                                    ).toLocaleString(language, {
                                        maximumFractionDigits: 6,
                                    }),
                                })}
                            </p>
                        )}
                        <p className="type-footnote text-label-secondary">
                            {t("aiResearch.apiOnlyBilling")}
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="ai-disclosure-mode">
                            {t("aiResearch.disclosureMode")}
                        </Label>
                        <Select
                            value={disclosureMode}
                            onValueChange={(value) => {
                                const nextMode = value as typeof disclosureMode;
                                setDisclosureMode(nextMode);
                                if (nextMode === "cloud-synthesis-selected")
                                    setResearchMode("local-only");
                                setPreview(null);
                            }}
                        >
                            <SelectTrigger id="ai-disclosure-mode">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="cloud-plan-public">
                                    {t("aiResearch.cloudPublic")}
                                </SelectItem>
                                <SelectItem value="selected-summary">
                                    {t("aiResearch.selectedSummary")}
                                </SelectItem>
                                <SelectItem value="cloud-synthesis-selected">
                                    {t("aiResearch.cloudSynthesisSelected")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    {disclosureMode === "selected-summary" && (
                        <Textarea
                            className="min-h-16"
                            aria-label={t("aiResearch.selectedSummary")}
                            value={selectedSummary}
                            onChange={(event) => {
                                setSelectedSummary(event.target.value);
                                setPreview(null);
                            }}
                            placeholder={t(
                                "aiResearch.selectedSummaryPlaceholder",
                            )}
                        />
                    )}
                    {disclosureMode === "cloud-plan-public" && (
                        <Textarea
                            className="min-h-16"
                            aria-label={t("aiResearch.cloudPublic")}
                            value={publicQuestion}
                            onChange={(event) => {
                                setPublicQuestion(event.target.value);
                                setPreview(null);
                            }}
                            placeholder={t(
                                "aiResearch.publicQuestionPlaceholder",
                            )}
                        />
                    )}
                    {disclosureMode === "cloud-synthesis-selected" && (
                        <Textarea
                            className="min-h-28"
                            aria-label={t("aiResearch.cloudSynthesisSelected")}
                            value={selectedEvidence}
                            onChange={(event) => {
                                setSelectedEvidence(event.target.value);
                                setPreview(null);
                            }}
                            placeholder={t(
                                "aiResearch.selectedEvidencePlaceholder",
                            )}
                        />
                    )}
                    <div className="space-y-1 type-footnote text-label-secondary">
                        <p>
                            {t(
                                disclosureMode === "cloud-synthesis-selected"
                                    ? "aiResearch.summary.reviewEvidence"
                                    : "aiResearch.summary.reviewPayload",
                            )}
                        </p>
                        {aiResearchStatus?.openai.agentCloakPreflight
                            ?.enabled && (
                            <p>
                                {t(
                                    aiResearchStatus.openai.agentCloakPreflight
                                        .location === "desktop-loopback"
                                        ? "aiResearch.agentCloakDesktopPreflight"
                                        : "aiResearch.agentCloakPreflight",
                                )}
                            </p>
                        )}
                        {(disclosureMode === "selected-summary" ||
                            disclosureMode === "cloud-synthesis-selected") && (
                            <p>{t("aiResearch.reversibleReferenceHint")}</p>
                        )}
                    </div>
                </div>
            )}
            {route === "openai-api" && preview && (
                <div className="space-y-2">
                    {preview.agentCloakPreflight.enabled && (
                        <p className="type-footnote text-label-secondary">
                            {t("aiResearch.agentCloakPassed")}
                        </p>
                    )}
                    {preview.referenceScope && (
                        <p className="type-footnote text-warning">
                            {t("aiResearch.reversibleReferenceWarning", {
                                count: preview.referenceScope.count,
                            })}
                        </p>
                    )}
                    <pre className={codeBlockClass}>
                        {JSON.stringify(preview.payload, null, 2)}
                    </pre>
                </div>
            )}
            <InvestigationPrivacySummary
                route={route}
                disclosureMode={disclosureMode}
                researchMode={researchMode}
                depth={depth}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-4">
                <Button onClick={run} disabled={runDisabled}>
                    {route === "openai-api"
                        ? preview
                            ? t("aiResearch.consentRun")
                            : t("aiResearch.preview")
                        : t("aiResearch.run")}
                </Button>
                {grantId && (
                    <Button
                        variant="outline"
                        onClick={() =>
                            void apiClient
                                .revokeAiDisclosureGrant(grantId)
                                .then(() => setGrantId(null))
                        }
                    >
                        {t("aiResearch.revoke")}
                    </Button>
                )}
                {job &&
                    !["completed", "failed", "cancelled", "partial"].includes(
                        job.state,
                    ) && (
                        <Button
                            variant="outline"
                            onClick={() =>
                                void apiClient.cancelInvestigation(job.id)
                            }
                        >
                            {t("aiResearch.cancel")}
                        </Button>
                    )}
                {job && ["partial", "failed"].includes(job.state) && (
                    <Button
                        variant="outline"
                        onClick={() =>
                            void apiClient
                                .resumeInvestigation(
                                    job.id,
                                    "Refresh local evidence",
                                    input().scope,
                                )
                                .then(setJob)
                                .catch((cause) =>
                                    setError(failureMessage(cause)),
                                )
                        }
                    >
                        {t("aiResearch.resume")}
                    </Button>
                )}
                {job && (
                    <Button
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                            setBusy(true);
                            setError(null);
                            void apiClient
                                .deleteInvestigation(job.id)
                                .then(() => setJob(null))
                                .catch((cause) =>
                                    setError(failureMessage(cause)),
                                )
                                .finally(() => setBusy(false));
                        }}
                    >
                        {t("aiResearch.deleteInvestigation")}
                    </Button>
                )}
                <span className="type-footnote text-label-secondary">
                    {job
                        ? t("aiResearch.jobState", { state: job.state })
                        : t("aiResearch.localDefault")}
                </span>
            </div>
            <Card asChild className="rounded-none border-x-0 border-t-0 bg-transparent shadow-none">
                <Disclosure>
                    <DisclosureSummary
                        padded
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                    >
                        {t("aiResearch.disclosureHistory")}
                    </DisclosureSummary>
                    <DisclosureContent className="space-y-3 pt-0">
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    void Promise.all([
                                        apiClient.listAiDisclosureRecords(),
                                        apiClient.listAiDisclosureGrants(),
                                    ]).then(([records, grants]) => {
                                        setRecordCount(records.total);
                                        setDisclosureRecords(records.items);
                                        setDisclosureGrants(grants.items);
                                    })
                                }
                            >
                                {recordCount == null
                                    ? t("aiResearch.inspectRecords")
                                    : t("aiResearch.recordCount", {
                                          count: recordCount,
                                      })}
                            </Button>
                            {recordCount != null && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() =>
                                        void apiClient
                                            .deleteAiDisclosureRecords()
                                            .then(() => {
                                                setRecordCount(0);
                                                setDisclosureRecords([]);
                                                setDisclosureGrants([]);
                                                setGrantId(null);
                                            })
                                    }
                                >
                                    {t("aiResearch.deleteRecords")}
                                </Button>
                            )}
                        </div>
                        {disclosureGrants.length > 0 && (
                            <List>
                                {disclosureGrants.map((grant) => (
                                    <ListRow
                                        key={String(grant.id)}
                                        title={
                                            <code className="type-footnote">
                                                {String(grant.mode)} ·{" "}
                                                {String(grant.id)}
                                            </code>
                                        }
                                        trailing={
                                            !grant.revoked_at ? (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() =>
                                                        void apiClient
                                                            .revokeAiDisclosureGrant(
                                                                String(
                                                                    grant.id,
                                                                ),
                                                            )
                                                            .then(() =>
                                                                setDisclosureGrants(
                                                                    (items) =>
                                                                        items.map(
                                                                            (
                                                                                item,
                                                                            ) =>
                                                                                item.id ===
                                                                                grant.id
                                                                                    ? {
                                                                                          ...item,
                                                                                          revoked_at:
                                                                                              new Date().toISOString(),
                                                                                      }
                                                                                    : item,
                                                                        ),
                                                                ),
                                                            )
                                                    }
                                                >
                                                    {t("aiResearch.revoke")}
                                                </Button>
                                            ) : undefined
                                        }
                                    />
                                ))}
                            </List>
                        )}
                        {disclosureRecords.map((record) => (
                            <pre
                                key={String(record.id)}
                                className={codeBlockClass}
                            >
                                {JSON.stringify(record, null, 2)}
                            </pre>
                        ))}
                    </DisclosureContent>
                </Disclosure>
            </Card>
            {error && (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {job?.state === "waiting" && (
                <Alert variant="warning">
                    <AlertDescription className="space-y-3">
                        <p>
                            {job.plan?.ambiguity?.question ??
                                t("aiResearch.clarificationNeeded")}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Input
                                className="min-w-0 flex-1"
                                aria-label={t("aiResearch.clarificationNeeded")}
                                value={clarification}
                                onChange={(event) =>
                                    setClarification(event.target.value)
                                }
                                placeholder={t(
                                    "aiResearch.clarificationPlaceholder",
                                )}
                            />
                            <Button
                                disabled={!clarification.trim()}
                                onClick={() =>
                                    void apiClient
                                        .resumeInvestigation(
                                            job.id,
                                            clarification.trim(),
                                            input().scope,
                                        )
                                        .then(setJob)
                                }
                            >
                                {t("aiResearch.resume")}
                            </Button>
                        </div>
                    </AlertDescription>
                </Alert>
            )}
            {job?.result && <EvidenceAnswer answer={job.result} />}
            <ConfirmDialog />
        </section>
    );
}
