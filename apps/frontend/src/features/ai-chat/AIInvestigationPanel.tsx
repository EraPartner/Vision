import { useEffect, useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { resolveOpenAiModel } from "@/features/ai-chat/openAiModelSelection";
import { useAiResearchStatus } from "@/hooks/useAiResearchStatus";
import { resolveAnalysisPreferences } from "@/lib/analysisPreferences";

const EMPTY_OPENAI_MODELS: OpenAiResearchModel[] = [];

function EvidenceAnswer({ answer }: { answer: AiAnswer }) {
    const { t } = useLanguage();
    const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
        null,
    );
    const evidence = useMemo(
        () => new Map(answer.evidence.map((item) => [item.id, item])),
        [answer.evidence],
    );
    const section = (
        label: string,
        items: Array<{ text: string; evidenceIds: string[] }>,
    ) =>
        items.length ? (
            <section>
                <h4 className="mt-3 text-sm font-medium">{label}</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                    {items.map((item, index) => (
                        <li key={`${label}-${index}`}>
                            {item.text}
                            {item.evidenceIds.map((id) => (
                                <button
                                    key={id}
                                    type="button"
                                    className="ml-1 text-primary underline"
                                    title={
                                        evidence.get(id)?.excerpt ?? undefined
                                    }
                                    onClick={() => setSelectedEvidenceId(id)}
                                >
                                    {evidence.get(id)?.label ?? id}
                                </button>
                            ))}
                        </li>
                    ))}
                </ul>
            </section>
        ) : null;
    return (
        <div
            className="mt-3 rounded-xl border border-border/60 p-4"
            data-testid="ai-evidence-answer"
        >
            <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t(`aiResearch.status.${answer.status}`)}</span>
                <span>
                    {answer.language.toUpperCase()} · {answer.depth}
                </span>
            </div>
            <p className="mt-2 text-sm">{answer.summary}</p>
            {section(t("aiResearch.facts"), answer.facts)}
            {section(t("aiResearch.calculations"), answer.calculations)}
            {section(t("aiResearch.interpretations"), answer.interpretations)}
            {answer.assumptions.length > 0 && (
                <p className="mt-3 text-xs">
                    <strong>{t("aiResearch.assumptions")}:</strong>{" "}
                    {answer.assumptions.join("; ")}
                </p>
            )}
            {answer.missingInformation.length > 0 && (
                <p className="mt-2 text-xs text-warning">
                    <strong>{t("aiResearch.missing")}:</strong>{" "}
                    {answer.missingInformation.join("; ")}
                </p>
            )}
            {answer.analysisReference && (
                <Button asChild size="sm" variant="outline" className="mt-3">
                    <Link
                        to={`/analysis?savedAnalysis=${encodeURIComponent(answer.analysisReference.id)}`}
                    >
                        {t("aiResearch.openAnalysis")}
                    </Link>
                </Button>
            )}
            {selectedEvidenceId && evidence.get(selectedEvidenceId) && (
                <aside className="mt-3 rounded-md bg-muted p-3 text-xs">
                    <strong>{evidence.get(selectedEvidenceId)?.label}</strong>
                    <p className="mt-1 whitespace-pre-wrap">
                        {evidence.get(selectedEvidenceId)?.excerpt}
                    </p>
                    {evidence.get(selectedEvidenceId)?.kind === "web" &&
                    /^https:\/\//.test(
                        evidence.get(selectedEvidenceId)?.locator ?? "",
                    ) ? (
                        <a
                            className="mt-2 inline-block text-primary underline"
                            href={evidence.get(selectedEvidenceId)?.locator}
                            target="_blank"
                            rel="noreferrer"
                        >
                            {evidence.get(selectedEvidenceId)?.locator}
                        </a>
                    ) : (
                        <code className="mt-2 block break-all">
                            {evidence.get(selectedEvidenceId)?.locator}
                        </code>
                    )}
                </aside>
            )}
        </div>
    );
}

export function AIInvestigationPanel() {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: aiResearchStatus } = useAiResearchStatus();
    const [question, setQuestion] = useState("");
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
            setError(
                cause instanceof Error ? cause.message : t("aiResearch.failed"),
            );
        } finally {
            setBusy(false);
        }
    };
    return (
        <section
            className="border-b border-border/50 p-4"
            aria-labelledby="ai-investigation-heading"
        >
            <h2 id="ai-investigation-heading" className="text-sm font-semibold">
                {t("aiResearch.title")}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <label className="cursor-pointer rounded-md border px-2 py-1 hover:bg-muted">
                    {t("aiResearch.addDocument")}
                    <input
                        className="sr-only"
                        type="file"
                        accept="text/plain,text/markdown,text/html,.md,.txt,.html"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            setBusy(true);
                            void apiClient
                                .uploadResearchDocument(file)
                                .then((document) =>
                                    setDocuments((items) => [
                                        document,
                                        ...items,
                                    ]),
                                )
                                .catch((cause) =>
                                    setError(
                                        cause instanceof Error
                                            ? cause.message
                                            : t("aiResearch.failed"),
                                    ),
                                )
                                .finally(() => setBusy(false));
                            event.target.value = "";
                        }}
                    />
                </label>
                <span className="text-muted-foreground">
                    {t("aiResearch.documentCount", { count: documents.length })}
                </span>
                {documents.map((document) => (
                    <span
                        key={document.id}
                        className="rounded-md bg-muted px-2 py-1"
                    >
                        {document.title} · {document.extractionStatus}
                        <button
                            type="button"
                            className="ml-2 text-destructive"
                            aria-label={t("aiResearch.deleteDocument")}
                            onClick={() =>
                                void apiClient
                                    .deleteResearchDocument(document.id)
                                    .then(() =>
                                        setDocuments((items) =>
                                            items.filter(
                                                (item) =>
                                                    item.id !== document.id,
                                            ),
                                        ),
                                    )
                            }
                        >
                            ×
                        </button>
                    </span>
                ))}
            </div>
            {researchMode === "public-web" && (
                <div className="mt-2">
                    <label
                        className="text-xs font-medium"
                        htmlFor="ai-public-web-query"
                    >
                        {t("aiResearch.publicWebQuery")}
                    </label>
                    <input
                        id="ai-public-web-query"
                        className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
                        value={publicWebQuery}
                        onChange={(event) =>
                            setPublicWebQuery(event.target.value)
                        }
                        placeholder={t("aiResearch.publicWebQueryPlaceholder")}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                        {t("aiResearch.publicWebQueryHelp")}
                    </p>
                </div>
            )}
            {researchMode === "public-providers" && (
                <div className="mt-2">
                    <label
                        className="text-xs font-medium"
                        htmlFor="ai-public-symbols"
                    >
                        {t("aiResearch.publicSymbols")}
                    </label>
                    <input
                        id="ai-public-symbols"
                        className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
                        value={publicSymbols}
                        onChange={(event) =>
                            setPublicSymbols(event.target.value)
                        }
                        placeholder={t("aiResearch.publicSymbolsPlaceholder")}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                        {t("aiResearch.publicSymbolsHelp")}
                    </p>
                </div>
            )}
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
                <textarea
                    className="min-h-20 rounded-md border bg-background p-2 text-sm"
                    value={question}
                    onChange={(event) => {
                        setQuestion(event.target.value);
                        setPreview(null);
                    }}
                    placeholder={t("aiResearch.question")}
                />
                <select
                    aria-label={t("aiResearch.depth")}
                    className="rounded-md border bg-background px-2 text-sm"
                    value={depth}
                    onChange={(event) =>
                        setDepthOverride(
                            event.target.value as "quick" | "detailed",
                        )
                    }
                >
                    <option value="quick">{t("aiResearch.quick")}</option>
                    <option value="detailed">{t("aiResearch.detailed")}</option>
                </select>
                <select
                    aria-label={t("aiResearch.researchMode")}
                    className="rounded-md border bg-background px-2 text-sm"
                    value={researchMode}
                    disabled={
                        route === "openai-api" &&
                        disclosureMode === "cloud-synthesis-selected"
                    }
                    onChange={(event) =>
                        setResearchMode(
                            event.target.value as typeof researchMode,
                        )
                    }
                >
                    <option value="local-only">
                        {t("aiResearch.localOnly")}
                    </option>
                    <option value="public-providers">
                        {t("aiResearch.publicProviders")}
                    </option>
                    <option value="public-web">
                        {t("aiResearch.publicWeb")}
                    </option>
                </select>
                <select
                    aria-label={t("aiResearch.route")}
                    className="rounded-md border bg-background px-2 text-sm"
                    value={route}
                    onChange={(event) => {
                        setRoute(event.target.value as typeof route);
                        setPreview(null);
                    }}
                >
                    <option value="local">{t("aiResearch.localModel")}</option>
                    <option value="openai-api" disabled={!openAiEnabled}>
                        {t("aiResearch.openAi")}
                    </option>
                </select>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
                {t("aiResearch.effectivePreferences", {
                    currency: resolvedPreferences.currency,
                    benchmark:
                        resolvedPreferences.benchmark ??
                        t("aiResearch.noBenchmark"),
                })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
                <label className="text-xs">
                    {t("aiResearch.dateFrom")}
                    <input
                        type="date"
                        className="ml-2 rounded-md border bg-background px-2 py-1"
                        value={dateFrom}
                        onChange={(event) => setDateFrom(event.target.value)}
                    />
                </label>
                <label className="text-xs">
                    {t("aiResearch.dateTo")}
                    <input
                        type="date"
                        className="ml-2 rounded-md border bg-background px-2 py-1"
                        value={dateTo}
                        onChange={(event) => setDateTo(event.target.value)}
                    />
                </label>
            </div>
            {route === "openai-api" && (
                <div className="mt-2 space-y-2">
                    <div>
                        <label
                            className="text-xs font-medium"
                            htmlFor="ai-openai-model"
                        >
                            {t("aiResearch.openAiModel")}
                        </label>
                        <select
                            id="ai-openai-model"
                            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
                            value={openAiModel}
                            disabled={
                                !openAiEnabled || openAiModels.length === 0
                            }
                            onChange={(event) => {
                                setOpenAiModelOverride(event.target.value);
                                setPreview(null);
                            }}
                        >
                            {openAiModels.length === 0 && (
                                <option value="">
                                    {t("aiResearch.noOpenAiModels")}
                                </option>
                            )}
                            {openAiModels.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.label} ({model.id})
                                    {model.isDefault
                                        ? ` — ${t("aiResearch.defaultModel")}`
                                        : ""}
                                </option>
                            ))}
                        </select>
                        {selectedOpenAiModel && (
                            <p className="mt-1 text-xs text-muted-foreground">
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
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t("aiResearch.apiOnlyBilling")}
                        </p>
                    </div>
                    <select
                        aria-label={t("aiResearch.disclosureMode")}
                        className="rounded-md border bg-background px-2 py-1 text-sm"
                        value={disclosureMode}
                        onChange={(event) => {
                            const nextMode = event.target
                                .value as typeof disclosureMode;
                            setDisclosureMode(nextMode);
                            if (nextMode === "cloud-synthesis-selected")
                                setResearchMode("local-only");
                            setPreview(null);
                        }}
                    >
                        <option value="cloud-plan-public">
                            {t("aiResearch.cloudPublic")}
                        </option>
                        <option value="selected-summary">
                            {t("aiResearch.selectedSummary")}
                        </option>
                        <option value="cloud-synthesis-selected">
                            {t("aiResearch.cloudSynthesisSelected")}
                        </option>
                    </select>
                    {disclosureMode === "selected-summary" && (
                        <textarea
                            className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
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
                        <textarea
                            className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
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
                        <textarea
                            className="min-h-28 w-full rounded-md border bg-background p-2 text-sm"
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
                    <p className="text-xs text-muted-foreground">
                        {t(
                            disclosureMode === "cloud-synthesis-selected"
                                ? "aiResearch.cloudSynthesisWarning"
                                : "aiResearch.cloudRetention",
                        )}
                    </p>
                    {aiResearchStatus?.openai.agentCloakPreflight?.enabled && (
                        <p className="text-xs text-muted-foreground">
                            {t("aiResearch.agentCloakPreflight")}
                        </p>
                    )}
                    {(disclosureMode === "selected-summary" ||
                        disclosureMode === "cloud-synthesis-selected") && (
                        <p className="text-xs text-muted-foreground">
                            {t("aiResearch.reversibleReferenceHint")}
                        </p>
                    )}
                </div>
            )}
            {route === "openai-api" && preview && (
                <div className="mt-2 space-y-1">
                    {preview.agentCloakPreflight.enabled && (
                        <p className="text-xs text-muted-foreground">
                            {t("aiResearch.agentCloakPassed")}
                        </p>
                    )}
                    {preview.referenceScope && (
                        <p className="text-xs text-warning">
                            {t("aiResearch.reversibleReferenceWarning", {
                                count: preview.referenceScope.count,
                            })}
                        </p>
                    )}
                    <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">
                        {JSON.stringify(preview.payload, null, 2)}
                    </pre>
                </div>
            )}
            <details className="mt-2 rounded-md border p-2 text-xs" open>
                <summary className="cursor-pointer font-medium">
                    {t("aiResearch.modeGuideTitle")}
                </summary>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {[
                        "aiResearch.modeLocalProfile",
                        "aiResearch.modeCloudPublicProfile",
                        "aiResearch.modeSelectedSummaryProfile",
                        "aiResearch.modeCloudSynthesisProfile",
                    ].map((key) => (
                        <p key={key} className="rounded bg-muted p-2">
                            {t(key)}
                        </p>
                    ))}
                </div>
                <h3 className="mt-3 font-medium">
                    {t("aiResearch.researchProfilesTitle")}
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                    <li>{t("aiResearch.researchLocalProfile")}</li>
                    <li>{t("aiResearch.researchProvidersProfile")}</li>
                    <li>{t("aiResearch.researchWebProfile")}</li>
                </ul>
                <h3 className="mt-3 font-medium">
                    {t("aiResearch.depthProfilesTitle")}
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                    <li>{t("aiResearch.quickProfile")}</li>
                    <li>{t("aiResearch.detailedProfile")}</li>
                </ul>
            </details>
            <div className="mt-2 flex flex-wrap gap-2">
                <Button
                    size="sm"
                    onClick={run}
                    disabled={
                        busy ||
                        !question.trim() ||
                        (researchMode === "public-web" &&
                            !publicWebQuery.trim()) ||
                        (researchMode === "public-providers" &&
                            !publicSymbols.trim()) ||
                        (route === "openai-api" &&
                            (!openAiEnabled || !openAiModel)) ||
                        (route === "openai-api" &&
                            disclosureMode === "cloud-plan-public" &&
                            !publicQuestion.trim()) ||
                        (route === "openai-api" &&
                            disclosureMode === "selected-summary" &&
                            !selectedSummary.trim()) ||
                        (route === "openai-api" &&
                            disclosureMode === "cloud-synthesis-selected" &&
                            !selectedEvidence.trim())
                    }
                >
                    {route === "openai-api"
                        ? preview
                            ? t("aiResearch.consentRun")
                            : t("aiResearch.preview")
                        : t("aiResearch.run")}
                </Button>
                {grantId && (
                    <Button
                        size="sm"
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
                <Button
                    size="sm"
                    variant="ghost"
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
                        : t("aiResearch.recordCount", { count: recordCount })}
                </Button>
                {recordCount != null && (
                    <Button
                        size="sm"
                        variant="ghost"
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
                {job &&
                    !["completed", "failed", "cancelled", "partial"].includes(
                        job.state,
                    ) && (
                        <Button
                            size="sm"
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
                        size="sm"
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
                                    setError(
                                        cause instanceof Error
                                            ? cause.message
                                            : t("aiResearch.failed"),
                                    ),
                                )
                        }
                    >
                        {t("aiResearch.resume")}
                    </Button>
                )}
                {job && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            setBusy(true);
                            setError(null);
                            void apiClient
                                .deleteInvestigation(job.id)
                                .then(() => setJob(null))
                                .catch((cause) =>
                                    setError(
                                        cause instanceof Error
                                            ? cause.message
                                            : t("aiResearch.failed"),
                                    ),
                                )
                                .finally(() => setBusy(false));
                        }}
                    >
                        {t("aiResearch.deleteInvestigation")}
                    </Button>
                )}
                <span className="self-center text-xs text-muted-foreground">
                    {job
                        ? t("aiResearch.jobState", { state: job.state })
                        : t("aiResearch.localDefault")}
                </span>
            </div>
            {recordCount != null && (
                <details className="mt-2 rounded-md border p-2 text-xs">
                    <summary className="cursor-pointer font-medium">
                        {t("aiResearch.disclosureHistory")}
                    </summary>
                    <div className="mt-2 space-y-2">
                        {disclosureGrants.map((grant) => (
                            <div
                                key={String(grant.id)}
                                className="flex items-center justify-between gap-2"
                            >
                                <code>
                                    {String(grant.mode)} · {String(grant.id)}
                                </code>
                                {!grant.revoked_at && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                            void apiClient
                                                .revokeAiDisclosureGrant(
                                                    String(grant.id),
                                                )
                                                .then(() =>
                                                    setDisclosureGrants(
                                                        (items) =>
                                                            items.map((item) =>
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
                                )}
                            </div>
                        ))}
                        {disclosureRecords.map((record) => (
                            <pre
                                key={String(record.id)}
                                className="overflow-auto rounded bg-muted p-2"
                            >
                                {JSON.stringify(record, null, 2)}
                            </pre>
                        ))}
                    </div>
                </details>
            )}
            {error && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                    {error}
                </p>
            )}
            {job?.state === "waiting" && (
                <div className="mt-3 rounded-md border border-warning/50 p-3">
                    <p className="text-sm">
                        {job.plan?.ambiguity?.question ??
                            t("aiResearch.clarificationNeeded")}
                    </p>
                    <div className="mt-2 flex gap-2">
                        <input
                            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                            value={clarification}
                            onChange={(event) =>
                                setClarification(event.target.value)
                            }
                            placeholder={t(
                                "aiResearch.clarificationPlaceholder",
                            )}
                        />
                        <Button
                            size="sm"
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
                </div>
            )}
            {job?.result && <EvidenceAnswer answer={job.result} />}
        </section>
    );
}
