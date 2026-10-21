import { CloudUpload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Disclosure,
    DisclosureSummary,
} from "@/components/ui/disclosure";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { SELECT_NONE, fromSelectValue, toSelectValue } from "@/lib/selectValue";
import { PortfolioBrokerField } from "@/features/portfolio/PortfolioBrokerField";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    importPortfolioCSVWithProgress,
    getPortfolioImportPreview,
    previewPortfolioImportReconciliation,
    commitReviewedPortfolioImports,
    type PortfolioReconciliationPlan,
    type PortfolioReconciliationPolicy,
    type ReviewedPortfolioImportResult,
} from "@/lib/api/portfolioImports";
import type { Account } from "@/types/api";
import {
    detectPortfolioImportFile,
    resolveDetectedPortfolioAccount,
    type DetectedPortfolioImport,
} from "./portfolioImportDetection";
import { portfolioImportPresetConfig } from "./portfolioImportPresets";
import { PortfolioImportHistory } from "./PortfolioImportHistory";
import { asAccountId } from "@vision/types/brands";
import type { AccountId } from "@vision/types/brands";

const STORAGE_KEY = "vision.portfolio-import.latest-session.v1";
const SETTINGS_STORAGE_KEY =
    "vision.portfolio-import.latest-review-settings.v1";
const storedSessionSchema = z
    .array(
        z.object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(["reference", "existing"]).optional(),
            accountId: z.number().int().positive().transform(asAccountId),
            adoptPolicy: z
                .enum(["preserve_existing", "prefer_source"])
                .optional(),
            batchId: z.number().int().positive(),
            detected: z
                .object({
                    source: z.enum([
                        "ibkr",
                        "kinesis",
                        "nexo",
                        "nexo_pro",
                        "saxo",
                    ]),
                    presetKey: z.literal("ibkr_funding_history").optional(),
                    sourceAccountIdentities: z.array(z.string()),
                })
                .optional(),
            transferDestinationAccountId: z
                .number()
                .int()
                .positive()
                .transform(asAccountId)
                .optional(),
            transferOriginAccountId: z
                .number()
                .int()
                .positive()
                .transform(asAccountId)
                .optional(),
            includedSymbols: z.string().optional(),
            status: z.literal("staged"),
            rows: z.number().int().nonnegative().optional(),
            skipped: z.number().int().nonnegative().optional(),
            sourceErrors: z.number().int().nonnegative().optional(),
            error: z.string().optional(),
            previousBatchIds: z.array(z.number().int().positive()).optional(),
        }),
    )
    .max(100);
interface Statement {
    id: string;
    name: string;
    file?: File | undefined;
    detected?: DetectedPortfolioImport | undefined;
    accountId?: AccountId | undefined;
    accountChosenManually?: boolean | undefined;
    adoptPolicy?: PortfolioReconciliationPolicy | undefined;
    transferDestinationAccountId?: AccountId | undefined;
    transferOriginAccountId?: AccountId | undefined;
    includedSymbols?: string | undefined;
    batchId?: number | undefined;
    previousBatchIds?: number[] | undefined;
    status:
        "detecting" | "ready" | "staging" | "staged" | "error" | "completed";
    skipped?: number | undefined;
    rows?: number | undefined;
    sourceErrors?: number | undefined;
    error?: string | undefined;
}

function readSession(): Statement[] {
    try {
        const stored: unknown = JSON.parse(
            sessionStorage.getItem(STORAGE_KEY) ?? "[]",
        );
        const parsed = storedSessionSchema.safeParse(stored);
        return parsed.success
            ? parsed.data
                  .filter((item) => item.kind === undefined)
                  .map(({ kind: _kind, ...item }) => item)
            : [];
    } catch {
        return [];
    }
}

function persistSession(statements: Statement[]) {
    try {
        const staged = statements.filter(
            (item) => item.batchId !== undefined && item.status === "staged",
        );
        if (staged.length === 0) sessionStorage.removeItem(STORAGE_KEY);
        else
            sessionStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(staged.map(({ file: _file, ...item }) => item)),
            );
    } catch {
        /* A storage restriction must not prevent staging or reviewing. */
    }
}

function sourceRoutingKey(statements: Statement[]) {
    return JSON.stringify(
        statements.map((item) => ({
            id: item.id,
            name: item.name,
            source: item.detected?.source,
            identities: item.detected?.sourceAccountIdentities,
            accountId: item.accountId,
            adoptPolicy: item.adoptPolicy,
            includedSymbols: item.includedSymbols ?? "",
            transferDestinationAccountId: item.transferDestinationAccountId,
            transferOriginAccountId: item.transferOriginAccountId,
        })),
    );
}
const storedSettingsSchema = z.object({
    sourceRoutingKey: z.string(),
    batchIds: z.array(z.number().int().positive()).min(1).max(100),
    policy: z.enum(["auto", "preserve_existing", "prefer_source"]),
});
function readSettings(statements: Statement[]) {
    try {
        const parsed = storedSettingsSchema.safeParse(
            JSON.parse(sessionStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null"),
        );
        if (
            parsed.success &&
            parsed.data.sourceRoutingKey === sourceRoutingKey(statements) &&
            JSON.stringify(parsed.data.batchIds) ===
                JSON.stringify(
                    statements
                        .map((item) => item.batchId)
                        .sort((a, b) => a! - b!),
                )
        )
            return parsed.data;
    } catch {
        /* Old or unavailable checkpoints use the original full-history defaults. */
    }
    return undefined;
}

const sourceLabels = {
    ibkr: "portfolioImport.ibkrParser",
    kinesis: "portfolioImport.kinesisParser",
    nexo: "portfolioImport.nexoParser",
    nexo_pro: "portfolioImport.nexoProParser",
    saxo: "portfolioImport.saxoParser",
};
/** The parser label of a detected statement; IBKR has two exports. */
const detectedLabel = (detected: DetectedPortfolioImport) =>
    detected.presetKey === "ibkr_funding_history"
        ? "portfolioImport.ibkrFundingParser"
        : sourceLabels[detected.source];
const actions = [
    "insert",
    "adopt",
    "duplicate",
    "duplicate_source",
    "cash",
    "transfer",
    "internal_annotation",
    "adjustment",
    "settled",
    "blocked",
    "policy_required",
];
const fields = [
    "date",
    "type",
    "units",
    "price_per_unit",
    "amount",
    "fees",
    "taxes",
    "currency",
    "fx_rate_to_eur",
    "dividend_amount_convention",
    "income_recognition_role",
];
const blockerKeys: Record<string, string> = {
    incomplete_source: "incomplete",
    invalid_source_values: "invalid",
    source_identity_conflict: "identity",
    missing_original_basis: "basis",
    ambiguous_history: "ambiguous",
    existing_assigned_or_imported_history: "assigned",
    missing_source_identity: "identity",
    source_policy_required: "policy",
    unproven_currency_conversion: "currency",
    unproven_economics: "economics",
    missing_companion_pro_history: "companionPro",
    unresolved_adjustment_kind: "adjustmentKind",
    unresolved_adjustment_basis: "adjustmentBasis",
    incomplete_adjustment: "adjustmentIncomplete",
    missing_adjustment_identity: "identity",
    unresolved_zero_yield_policy: "zeroYield",
    projected_history_conflict: "projectedHistory",
    cross_format_source_conflict: "crossFormat",
    ambiguous_funding_history: "ambiguousFunding",
    ambiguous_cash_history: "ambiguousCash",
};

interface Props {
    accounts: readonly Account[];
}

export function PortfolioImportSession({ accounts }: Props) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const [statements, setStatements] = useState<Statement[]>(readSession);
    const [initialSettings] = useState(() => readSettings(statements));
    const statementsRef = useRef(statements);
    const [policy, setPolicy] = useState<
        "auto" | PortfolioReconciliationPolicy
    >(initialSettings?.policy ?? "auto");
    const [operation, setOperation] = useState<
        "idle" | "staging" | "preview" | "commit" | "rollback"
    >("idle");
    const [review, setReview] = useState<{
        key: string;
        plan: PortfolioReconciliationPlan;
    }>();
    const [result, setResult] = useState<ReviewedPortfolioImportResult>();
    const [error, setError] = useState<string>();
    const [stopped, setStopped] = useState(false);
    const [shownActions, setShownActions] = useState(50);
    const revision = useRef(0);
    const counter = useRef(0);
    const stopRequested = useRef(false);
    const mounted = useRef(true);
    const locked =
        operation === "staging" ||
        operation === "commit" ||
        operation === "rollback";
    useUnsavedChanges(
        statements.some(
            (item) => !["staged", "completed"].includes(item.status),
        ),
    );

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            stopRequested.current = true;
        };
    }, []);

    const updateStatements = useCallback(
        (update: (previous: Statement[]) => Statement[]) => {
            const next = update(statementsRef.current);
            statementsRef.current = next;
            persistSession(next);
            if (mounted.current) setStatements(next);
        },
        [],
    );
    const invalidate = useCallback(() => {
        revision.current++;
        setReview(undefined);
        setResult(undefined);
        setError(undefined);
    }, []);
    useEffect(() => {
        const next = statementsRef.current.map((item) =>
            item.detected && item.batchId === undefined && !item.accountChosenManually
                ? {
                      ...item,
                      accountId: resolveDetectedPortfolioAccount(
                          item.detected,
                          accounts,
                      ),
                  }
                : item,
        );
        if (
            next.some(
                (item, index) =>
                    item.accountId !== statementsRef.current[index]?.accountId,
            )
        ) {
            invalidate();
            updateStatements(() => next);
        }
    }, [accounts, statements, updateStatements, invalidate]);
    const ids = statements
        .filter((item) => item.status === "staged")
        .map((item) => item.batchId!)
        .sort((a, b) => a - b);
    const routingKey = sourceRoutingKey(statements);
    const scope = {
        batchIds: ids,
        ...(policy === "auto" ? {} : { adoptPolicy: policy }),
        ...(statements.some(
            (item) =>
                item.status === "staged" && item.adoptPolicy !== undefined,
        )
            ? {
                  batchPolicies: statements
                      .filter(
                          (item) =>
                              item.status === "staged" &&
                              item.adoptPolicy !== undefined,
                      )
                      .map((item) => ({
                          batchId: item.batchId!,
                          adoptPolicy: item.adoptPolicy!,
                      }))
                      .sort((left, right) => left.batchId - right.batchId),
              }
            : {}),
    };
    const scopeKey = JSON.stringify({ scope, routingKey });
    useEffect(() => {
        try {
            const checkpointIds = statements
                .map((item) => item.batchId)
                .filter((id): id is number => id !== undefined)
                .sort((a, b) => a - b);
            if (
                checkpointIds.length === 0 ||
                statements.some((item) => item.status !== "staged")
            ) {
                sessionStorage.removeItem(SETTINGS_STORAGE_KEY);
                return;
            }
            sessionStorage.setItem(
                SETTINGS_STORAGE_KEY,
                JSON.stringify({
                    sourceRoutingKey: routingKey,
                    batchIds: checkpointIds,
                    policy,
                }),
            );
        } catch {
            /* Session storage restrictions cannot prevent import review. */
        }
    }, [statements, routingKey, policy]);
    const allStaged =
        statements.length > 0 &&
        statements.every((item) => item.status === "staged");
    const canStage =
        statements.length > 0 &&
        statements.some((item) => item.status !== "staged") &&
        statements.every(
            (item) =>
                item.status === "staged" ||
                (item.file &&
                    item.detected &&
                    accounts.some((account) => account.id === item.accountId) &&
                    item.status !== "detecting"),
        );
    const canCommit =
        allStaged &&
        review?.key === scopeKey &&
        review.plan.ready &&
        review.plan.blockers.length === 0 &&
        review.plan.actions.every(
            (action) =>
                actions.includes(action.action) &&
                !["blocked", "policy_required"].includes(action.action),
        );

    const addFiles = (files: File[]) => {
        if (locked || files.length === 0) return;
        if (statementsRef.current.length + files.length > 100) {
            setError(t("portfolioImport.session.tooMany"));
            return;
        }
        invalidate();
        setStopped(false);
        const entries: Statement[] = files.map((file) => ({
            id: `statement-${Date.now()}-${counter.current++}`,
            name: file.name,
            file,
            status: "detecting",
        }));
        updateStatements((previous) => [
            ...(previous.every((item) => item.status === "completed")
                ? []
                : previous),
            ...entries,
        ]);
        for (const entry of entries) {
            void detectPortfolioImportFile(entry.file!)
                .then((detected) => {
                    updateStatements((previous) =>
                        previous.map((item) =>
                            item.id === entry.id
                                ? {
                                      ...item,
                                      detected,
                                      accountId: detected
                                          ? resolveDetectedPortfolioAccount(
                                                detected,
                                                accounts,
                                            )
                                          : undefined,
                                      status: detected ? "ready" : "error",
                                      error: detected
                                          ? undefined
                                          : t(
                                                "portfolioImport.session.unsupported",
                                            ),
                                  }
                                : item,
                        ),
                    );
                })
                .catch(() =>
                    updateStatements((previous) =>
                        previous.map((item) =>
                            item.id === entry.id
                                ? {
                                      ...item,
                                      status: "error",
                                      error: t(
                                          "portfolioImport.detectionFailed",
                                      ),
                                  }
                                : item,
                        ),
                    ),
                );
        }
    };

    const changeAccount = (id: string, value: string) => {
        invalidate();
        updateStatements((previous) =>
            previous.map((item) =>
                item.id === id
                    ? {
                          ...item,
                          accountId: value
                              ? asAccountId(Number(value))
                              : undefined,
                          accountChosenManually: true,
                          batchId: undefined,
                          status: "ready",
                          previousBatchIds: item.batchId !== undefined
                              ? [...(item.previousBatchIds ?? []), item.batchId]
                              : item.previousBatchIds,
                          rows: undefined,
                          sourceErrors: undefined,
                          error: undefined,
                      }
                    : item,
            ),
        );
    };

    const changeAssetScope = (id: string, value: string) => {
        invalidate();
        updateStatements((previous) =>
            previous.map((item) =>
                item.id === id
                    ? {
                          ...item,
                          includedSymbols: value,
                          batchId: undefined,
                          status: "ready",
                          rows: undefined,
                          sourceErrors: undefined,
                          previousBatchIds: item.batchId !== undefined
                              ? [...(item.previousBatchIds ?? []), item.batchId]
                              : item.previousBatchIds,
                      }
                    : item,
            ),
        );
    };

    const changeStatementPolicy = (id: string, value: string) => {
        invalidate();
        updateStatements((previous) =>
            previous.map((item) =>
                item.id === id
                    ? {
                          ...item,
                          adoptPolicy: value
                              ? (value as PortfolioReconciliationPolicy)
                              : undefined,
                      }
                    : item,
            ),
        );
    };

    const changeTransferAccount = (id: string, value: string) => {
        invalidate();
        updateStatements((previous) =>
            previous.map((item) =>
                item.id === id
                    ? {
                          ...item,
                          transferDestinationAccountId: value
                              ? asAccountId(Number(value))
                              : undefined,
                          ...(item.detected?.source === "nexo"
                              ? {
                                    transferOriginAccountId: value
                                        ? asAccountId(Number(value))
                                        : undefined,
                                }
                              : {}),
                          batchId: undefined,
                          status: "ready",
                          rows: undefined,
                          sourceErrors: undefined,
                          previousBatchIds: item.batchId !== undefined
                              ? [...(item.previousBatchIds ?? []), item.batchId]
                              : item.previousBatchIds,
                      }
                    : item,
            ),
        );
    };

    const stage = async () => {
        if (!canStage || operation !== "idle") return;
        invalidate();
        setOperation("staging");
        setStopped(false);
        stopRequested.current = false;
        for (const item of statementsRef.current) {
            if (stopRequested.current) break;
            if (item.status === "staged") continue;
            updateStatements((previous) =>
                previous.map((row) =>
                    row.id === item.id
                        ? { ...row, status: "staging", error: undefined }
                        : row,
                ),
            );
            try {
                const config = {
                    ...portfolioImportPresetConfig(
                        item.detected!.presetKey ?? item.detected!.source,
                    )!,
                    accountId: item.accountId,
                    includedSymbols: item.includedSymbols,
                    transferDestinationAccountId:
                        item.transferDestinationAccountId,
                    transferOriginAccountId: item.transferOriginAccountId,
                    ...(item.detected?.source === "kinesis"
                        ? { yieldBasisPolicy: "zero" as const }
                        : {}),
                };
                const pending = importPortfolioCSVWithProgress(
                    item.file!,
                    config,
                    config.format ?? "portfolio_generic",
                    () => {},
                    { isBrokerage: true, accountId: item.accountId },
                );
                const staged = await pending.result;
                if (
                    !Number.isSafeInteger(staged.batch_id) ||
                    staged.batch_id <= 0 ||
                    staged.imported !== 0 ||
                    !staged.requires_review
                )
                    throw new Error(
                        t("portfolioImport.session.stageUnverified"),
                    );
                // Capture the returned batch before fetching its evidence. Stopping
                // waits for this statement, so its pending batch remains resumable.
                updateStatements((previous) =>
                    previous.map((row) =>
                        row.id === item.id
                            ? {
                                  ...row,
                                  batchId: staged.batch_id,
                                  status: "staged",
                                  skipped: staged.skipped,
                                  sourceErrors: staged.errors,
                              }
                            : row,
                    ),
                );
                const evidence = await getPortfolioImportPreview(
                    staged.batch_id,
                );
                updateStatements((previous) =>
                    previous.map((row) =>
                        row.id === item.id
                            ? {
                                  ...row,
                                  rows: evidence.groups.reduce(
                                      (sum, group) => sum + group.rows.length,
                                      0,
                                  ),
                                  sourceErrors:
                                      evidence.totals.error +
                                      evidence.totals.unresolved,
                              }
                            : row,
                    ),
                );
            } catch (failure) {
                const message = apiErrorToMessage(failure, t);
                updateStatements((previous) =>
                    previous.map((row) =>
                        row.id === item.id
                            ? {
                                  ...row,
                                  status: row.batchId !== undefined ? "staged" : "error",
                                  error: message,
                              }
                            : row,
                    ),
                );
                if (mounted.current)
                    setError(t("portfolioImport.session.stageFailed"));
                stopRequested.current = true;
            }
        }
        if (mounted.current) {
            setOperation("idle");
            setStopped(stopRequested.current);
        }
    };

    const preview = async () => {
        if (!allStaged || operation !== "idle") return;
        const currentRevision = ++revision.current;
        setReview(undefined);
        setError(undefined);
        setOperation("preview");
        try {
            const plan = await previewPortfolioImportReconciliation(scope);
            if (!mounted.current || revision.current !== currentRevision)
                return;
            if (
                JSON.stringify([...plan.batchIds].sort((a, b) => a - b)) !==
                    JSON.stringify(ids) ||
                plan.adoptPolicy !== (scope.adoptPolicy ?? null) ||
                JSON.stringify(plan.batchPolicies) !==
                    JSON.stringify(scope.batchPolicies ?? [])
            )
                throw new Error(t("portfolioImport.session.previewMismatch"));
            setReview({ key: scopeKey, plan });
            setShownActions(50);
        } catch (failure) {
            if (mounted.current && revision.current === currentRevision)
                setError(
                    failure instanceof Error &&
                        failure.name === "PortfolioImportResponseError"
                        ? t("portfolioImport.session.responseUnverified")
                        : apiErrorToMessage(failure, t),
                );
        } finally {
            if (mounted.current) setOperation("idle");
        }
    };

    const commit = async () => {
        if (!canCommit || operation !== "idle") return;
        setOperation("commit");
        setError(undefined);
        try {
            const committed = await commitReviewedPortfolioImports(scope);
            setResult(committed);
            setReview(undefined);
            updateStatements((previous) =>
                previous.map((item) => ({
                    ...item,
                    status: "completed",
                    sourceErrors:
                        committed.batches.find(
                            (batch) => batch.batch_id === item.batchId,
                        )?.errors ?? item.sourceErrors,
                })),
            );
            await queryClient.invalidateQueries();
        } catch (failure) {
            setReview(undefined);
            setError(
                failure instanceof Error &&
                    failure.name === "PortfolioImportResponseError"
                    ? t("portfolioImport.session.responseUnverified")
                    : apiErrorToMessage(failure, t),
            );
        } finally {
            if (mounted.current) setOperation("idle");
        }
    };

    const statementName = (batchId: number) =>
        statements.find((item) => item.batchId === batchId)?.name ??
        String(batchId);
    const accountName = (id: AccountId) =>
        accounts.find((account) => account.id === id)?.display_name ||
        accounts.find((account) => account.id === id)?.name ||
        t("portfolioImport.session.accountId", { id });
    const displayValue = (
        field: string,
        value: string | number | null | undefined,
    ) =>
        field === "dividend_amount_convention" && value != null
            ? t(`portfolioImport.session.convention.${value}`)
            : field === "income_recognition_role" && value != null
              ? t(`portfolio.incomeRole.${value}`)
              : String(value ?? "—");
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("portfolioImport.session.title")}</CardTitle>
                <CardDescription>
                    {t("portfolioImport.session.description")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <PortfolioImportHistory
                    disabled={operation !== "idle"}
                    onBusyChange={(busy) =>
                        setOperation(busy ? "rollback" : "idle")
                    }
                    onRolledBack={(batchId) => {
                        invalidate();
                        updateStatements((previous) =>
                            previous.filter((item) => item.batchId !== batchId),
                        );
                    }}
                />
                <div
                    className="relative rounded-card corner-continuous border border-dashed border-border/60 bg-muted/20 p-10 text-center transition-colors hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        addFiles(Array.from(event.dataTransfer.files));
                    }}
                >
                    <CloudUpload className="mx-auto mb-3 h-10 w-10 text-label-secondary" aria-hidden="true" />
                    <Label htmlFor="portfolio-session-files" className="block type-body font-medium">
                        {t("portfolioImport.session.files")}
                    </Label>
                    <Input
                        id="portfolio-session-files"
                        type="file"
                        accept=".csv,.xlsx,.xls"
                        multiple
                        disabled={locked}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                        aria-label={t("portfolioImport.session.files")}
                        onChange={(event) => {
                            addFiles(Array.from(event.target.files ?? []));
                            event.target.value = "";
                        }}
                    />
                </div>
                {statements.length > 0 && (
                    <ul className="divide-y divide-border/50 rounded-card corner-continuous border border-border/60">
                        {statements.map((item) => (
                            <li key={item.id} className="space-y-3 p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="break-words type-body font-medium">
                                            {item.name}
                                        </p>
                                        <p className="type-caption text-label-secondary">
                                            {t(
                                                item.detected
                                                    ? detectedLabel(
                                                          item.detected,
                                                      )
                                                    : "portfolioImport.session.detecting",
                                            )}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label={t(
                                            "portfolioImport.session.removeFile",
                                            { name: item.name },
                                        )}
                                        disabled={locked}
                                        onClick={() => {
                                            invalidate();
                                            updateStatements((previous) =>
                                                previous.filter(
                                                    (row) => row.id !== item.id,
                                                ),
                                            );
                                        }}
                                    >
                                        {t("portfolioImport.session.remove")}
                                    </Button>
                                </div>
                                {item.detected && (
                                    <fieldset
                                        aria-label={t(
                                            "portfolioImport.session.statementBroker",
                                            { name: item.name },
                                        )}
                                        disabled={
                                            locked ||
                                            !item.file ||
                                            item.status === "completed"
                                        }
                                    >
                                        <PortfolioBrokerField
                                            id={`broker-${item.id}`}
                                            accounts={accounts}
                                            value={
                                                item.accountId !== undefined
                                                    ? String(item.accountId)
                                                    : undefined
                                            }
                                            onChange={(value) =>
                                                changeAccount(item.id, value)
                                            }
                                            compactDefault
                                            t={t}
                                        />
                                    </fieldset>
                                )}
                                {item.detected && item.accountId === undefined && (
                                    <p
                                        role="alert"
                                        className="type-footnote text-destructive"
                                    >
                                        {t(
                                            "portfolioImport.session.accountRequired",
                                        )}
                                    </p>
                                )}
                                {/* Funding rows carry no asset to scope. */}
                                {item.detected &&
                                    item.detected.presetKey === undefined && (
                                    <div className="space-y-2">
                                        <Label
                                            htmlFor={`asset-scope-${item.id}`}
                                        >
                                            {t(
                                                "portfolioImport.session.assetScope",
                                            )}
                                        </Label>
                                        <Input
                                            id={`asset-scope-${item.id}`}
                                            value={item.includedSymbols ?? ""}
                                            disabled={
                                                locked ||
                                                !item.file ||
                                                item.status === "completed"
                                            }
                                            placeholder={t(
                                                "portfolioImport.session.allAssets",
                                            )}
                                            onChange={(event) =>
                                                changeAssetScope(
                                                    item.id,
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        <p className="type-footnote text-label-secondary">
                                            {t(
                                                "portfolioImport.session.assetScopeHelp",
                                            )}
                                        </p>
                                    </div>
                                )}
                                <div className="space-y-2">
                                    <Label htmlFor={`policy-${item.id}`}>
                                        {t(
                                            "portfolioImport.session.statementPolicy",
                                        )}
                                    </Label>
                                    <Select
                                        value={toSelectValue(item.adoptPolicy)}
                                        onValueChange={(value) =>
                                            changeStatementPolicy(
                                                item.id,
                                                fromSelectValue(value),
                                            )
                                        }
                                    >
                                        <SelectTrigger
                                            id={`policy-${item.id}`}
                                            aria-label={t(
                                                "portfolioImport.session.policyForFile",
                                                { name: item.name },
                                            )}
                                            disabled={
                                                locked ||
                                                item.status === "completed"
                                            }
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={SELECT_NONE}>
                                                {t(
                                                    "portfolioImport.session.useSessionPolicy",
                                                )}
                                            </SelectItem>
                                            <SelectItem value="preserve_existing">
                                                {t(
                                                    "portfolioImport.session.preserve",
                                                )}
                                            </SelectItem>
                                            <SelectItem value="prefer_source">
                                                {t(
                                                    "portfolioImport.session.source",
                                                )}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                {item.detected &&
                                    ["nexo", "kinesis"].includes(
                                        item.detected.source,
                                    ) && (
                                        <div className="space-y-2">
                                            <Label
                                                htmlFor={`transfer-${item.id}`}
                                            >
                                                {t(
                                                    item.detected.source ===
                                                        "nexo"
                                                        ? "portfolioImport.session.otherCustodyAccount"
                                                        : "portfolioImport.session.transferDestination",
                                                )}
                                            </Label>
                                            <Select
                                                value={toSelectValue(
                                                    item.detected.source !==
                                                        "nexo" ||
                                                        item.transferOriginAccountId ===
                                                            item.transferDestinationAccountId
                                                        ? item.transferDestinationAccountId?.toString()
                                                        : undefined,
                                                )}
                                                onValueChange={(value) =>
                                                    changeTransferAccount(
                                                        item.id,
                                                        fromSelectValue(value),
                                                    )
                                                }
                                            >
                                                <SelectTrigger
                                                    id={`transfer-${item.id}`}
                                                    disabled={
                                                        locked ||
                                                        !item.file ||
                                                        item.status ===
                                                            "completed"
                                                    }
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem
                                                        value={SELECT_NONE}
                                                    >
                                                        {t(
                                                            item.detected
                                                                .source ===
                                                                "nexo"
                                                                ? "portfolioImport.session.custodyUnassigned"
                                                                : "portfolioImport.session.transferUnassigned",
                                                        )}
                                                    </SelectItem>
                                                    {accounts
                                                        .filter(
                                                            (account) =>
                                                                account.id !==
                                                                item.accountId,
                                                        )
                                                        .map((account) => (
                                                            <SelectItem
                                                                key={account.id}
                                                                value={String(
                                                                    account.id,
                                                                )}
                                                            >
                                                                {account.display_name ||
                                                                    account.name}
                                                            </SelectItem>
                                                        ))}
                                                </SelectContent>
                                            </Select>
                                            <p className="type-caption text-label-secondary">
                                                {t(
                                                    item.detected.source ===
                                                        "nexo"
                                                        ? "portfolioImport.session.otherCustodyHint"
                                                        : "portfolioImport.session.transferHint",
                                                )}
                                            </p>
                                        </div>
                                    )}
                                {item.status === "staging" && (
                                    <p
                                        role="status"
                                        className="type-footnote text-label-secondary"
                                    >
                                        {t("portfolioImport.session.staging")}
                                    </p>
                                )}
                                {item.batchId !== undefined && (
                                    <p className="type-footnote text-label-secondary">
                                        <Link
                                            className="underline"
                                            to={`/portfolio/import/${item.batchId}/review`}
                                        >
                                            {t(
                                                "portfolioImport.session.batch",
                                                { id: item.batchId },
                                            )}
                                        </Link>
                                        {item.rows !== undefined &&
                                            ` · ${t("portfolioImport.session.rows", { n: item.rows, skipped: item.skipped ?? 0, errors: item.sourceErrors ?? 0 })}`}
                                    </p>
                                )}
                                {item.previousBatchIds?.map((batchId) => (
                                    <p
                                        key={batchId}
                                        className="type-caption text-label-secondary"
                                    >
                                        {t(
                                            "portfolioImport.session.previousPending",
                                        )}{" "}
                                        <Link
                                            className="underline"
                                            to={`/portfolio/import/${batchId}/review`}
                                        >
                                            {t(
                                                "portfolioImport.session.batch",
                                                { id: batchId },
                                            )}
                                        </Link>
                                    </p>
                                ))}
                                {item.error && (
                                    <p
                                        role="alert"
                                        className="type-footnote text-destructive"
                                    >
                                        {item.error}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <div className="space-y-2">
                    <Label htmlFor="portfolio-session-policy">
                        {t("portfolioImport.session.policy")}
                    </Label>
                    <Select
                        value={policy}
                        onValueChange={(value) => {
                            invalidate();
                            setPolicy(value as typeof policy);
                        }}
                    >
                        <SelectTrigger
                            id="portfolio-session-policy"
                            disabled={locked}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto">
                                {t("portfolioImport.session.auto")}
                            </SelectItem>
                            <SelectItem value="preserve_existing">
                                {t("portfolioImport.session.preserve")}
                            </SelectItem>
                            <SelectItem value="prefer_source">
                                {t("portfolioImport.session.source")}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="type-footnote text-label-secondary">
                        {t(`portfolioImport.session.policyHint.${policy}`)}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        onClick={() => void stage()}
                        disabled={!canStage || operation !== "idle"}
                    >
                        {t("portfolioImport.session.stage")}
                    </Button>
                    {operation === "staging" && (
                        <Button
                            variant="outline"
                            onClick={() => {
                                stopRequested.current = true;
                            }}
                        >
                            {t("portfolioImport.session.stop")}
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        onClick={() => void preview()}
                        disabled={!allStaged || operation !== "idle"}
                    >
                        {t("portfolioImport.session.preview")}
                    </Button>
                    {statements.length > 0 && (
                        <Button
                            variant="ghost"
                            disabled={locked}
                            onClick={() => {
                                invalidate();
                                updateStatements(() => []);
                            }}
                        >
                            {t("portfolioImport.session.clear")}
                        </Button>
                    )}
                </div>
                {stopped && (
                    <p
                        role="status"
                        className="type-footnote text-label-secondary"
                    >
                        {t("portfolioImport.session.stopped")}
                    </p>
                )}
                {operation === "preview" && (
                    <p
                        role="status"
                        className="type-footnote text-label-secondary"
                    >
                        {t("portfolioImport.session.previewing")}
                    </p>
                )}
                {error && (
                    <p role="alert" className="type-footnote text-destructive">
                        {error}
                    </p>
                )}
                {review && (
                    <section
                        aria-label={t("portfolioImport.session.review")}
                        className="space-y-4 rounded-card corner-continuous border border-border/60 bg-card/70 p-4"
                    >
                        <h3 className="type-headline">
                            {t("portfolioImport.session.review")}
                        </h3>
                        <dl className="grid grid-cols-2 gap-3 type-body sm:grid-cols-3">
                            {actions
                                .filter(
                                    (action) =>
                                        (review.plan.summary[action] ?? 0) > 0,
                                )
                                .map((action) => (
                                    <div key={action}>
                                        <dt className="type-caption text-label-tertiary">
                                            {t(
                                                `portfolioImport.session.actions.${action}`,
                                            )}
                                        </dt>
                                        <dd className="type-title-3 tabular-nums">
                                            {review.plan.summary[action]}
                                        </dd>
                                    </div>
                                ))}
                        </dl>
                        {review.plan.blockers.length > 0 && (
                            <div
                                role="alert"
                                className="space-y-2 type-footnote text-destructive"
                            >
                                <p>{t("portfolioImport.session.blocked")}</p>
                                <ul className="space-y-1">
                                    {review.plan.blockers.map(
                                        (blocker, index) => (
                                            <li
                                                key={`${blocker.batchId}-${blocker.rowId ?? index}-${blocker.reason}`}
                                            >
                                                {statementName(blocker.batchId)}
                                                {blocker.rowOrdinal !== undefined && (
                                                    <>
                                                        {" "}
                                                        ·{" "}
                                                        {t(
                                                            "portfolioImport.session.row",
                                                            {
                                                                n: blocker.rowOrdinal,
                                                            },
                                                        )}
                                                    </>
                                                )}
                                                :{" "}
                                                {t(
                                                    `portfolioImport.session.blockers.${blockerKeys[blocker.reason] ?? "other"}`,
                                                )}
                                            </li>
                                        ),
                                    )}
                                </ul>
                            </div>
                        )}
                        <Disclosure>
                            <DisclosureSummary>
                                {t("portfolioImport.session.evidence")}
                            </DisclosureSummary>
                            <div className="mt-3 space-y-3">
                                {review.plan.actions
                                    .slice(0, shownActions)
                                    .map((action) => (
                                        <article
                                            key={`${action.batchId}-${action.rowId}`}
                                            className="rounded-card corner-continuous border border-border/60 p-3 type-body"
                                        >
                                            <p className="font-medium">
                                                {statementName(action.batchId)}{" "}
                                                ·{" "}
                                                {t(
                                                    "portfolioImport.session.row",
                                                    { n: action.rowOrdinal },
                                                )}{" "}
                                                ·{" "}
                                                {t(
                                                    `portfolioImport.session.actions.${actions.includes(action.action) ? action.action : "other"}`,
                                                )}
                                            </p>
                                            {action.existingTransactionId !== undefined && (
                                                <p className="type-caption text-label-secondary">
                                                    {t(
                                                        "portfolioImport.session.existingId",
                                                        {
                                                            id: action.existingTransactionId,
                                                        },
                                                    )}
                                                </p>
                                            )}
                                            {action.policy && (
                                                <p className="mt-1 type-caption text-label-secondary">
                                                    {t(
                                                        "portfolioImport.session.appliedPolicy",
                                                        {
                                                            policy: t(
                                                                `portfolioImport.session.policyName.${action.policy}`,
                                                            ),
                                                        },
                                                    )}
                                                </p>
                                            )}
                                            {action.action ===
                                                "internal_annotation" && (
                                                <p className="mt-1 type-caption text-label-secondary">
                                                    {t(
                                                        "portfolioImport.session.annotationHint",
                                                    )}
                                                </p>
                                            )}
                                            {action.transfer && (
                                                <dl className="mt-2 grid grid-cols-2 gap-2 type-caption">
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.fields.date",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {action.transfer.date}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.transferSource",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {accountName(
                                                            action.transfer
                                                                .sourceAccountId,
                                                        )}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.transferDestination",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {accountName(
                                                            action.transfer
                                                                .destinationAccountId,
                                                        )}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.grossDebit",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {action.transfer.units}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.transferFee",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {
                                                            action.transfer
                                                                .feeUnits
                                                        }
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.netReceived",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {
                                                            action.transfer
                                                                .receivedUnits
                                                        }
                                                    </dd>
                                                </dl>
                                            )}
                                            {action.adjustment && (
                                                <dl className="mt-2 grid grid-cols-2 gap-2 type-caption">
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.fields.date",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {action.adjustment.date}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.adjustment.account",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {accountName(
                                                            action.adjustment
                                                                .accountId,
                                                        )}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.fields.units",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {
                                                            action.adjustment
                                                                .units
                                                        }
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.adjustment.kind",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {t(
                                                            `portfolioImport.session.adjustment.kind.${action.adjustment.kind}`,
                                                        )}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.adjustment.basis",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {t(
                                                            `portfolioImport.session.adjustment.basis.${action.adjustment.basisPolicy}`,
                                                        )}
                                                    </dd>
                                                </dl>
                                            )}
                                            {action.source && (
                                                <div className="mt-2 overflow-x-auto">
                                                    <table className="w-full text-left type-caption">
                                                        <thead>
                                                            <tr>
                                                                <th className="p-1">
                                                                    {t(
                                                                        "portfolioImport.session.field",
                                                                    )}
                                                                </th>
                                                                <th className="p-1">
                                                                    {t(
                                                                        "portfolioImport.session.sourceValues",
                                                                    )}
                                                                </th>
                                                                {action.existing && (
                                                                    <th className="p-1">
                                                                        {t(
                                                                            "portfolioImport.session.existingValues",
                                                                        )}
                                                                    </th>
                                                                )}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {fields
                                                                .filter(
                                                                    (field) =>
                                                                        action
                                                                            .source?.[
                                                                            field
                                                                        ] !=
                                                                            null ||
                                                                        action
                                                                            .existing?.[
                                                                            field
                                                                        ] !=
                                                                            null,
                                                                )
                                                                .map(
                                                                    (field) => (
                                                                        <tr
                                                                            key={
                                                                                field
                                                                            }
                                                                            className={
                                                                                action.corrections?.includes(
                                                                                    field,
                                                                                )
                                                                                    ? "bg-foreground/[0.06]"
                                                                                    : undefined
                                                                            }
                                                                        >
                                                                            <th
                                                                                scope="row"
                                                                                className="p-1 font-normal"
                                                                            >
                                                                                {t(
                                                                                    `portfolioImport.session.fields.${field}`,
                                                                                )}
                                                                            </th>
                                                                            <td className="p-1">
                                                                                {displayValue(
                                                                                    field,
                                                                                    action
                                                                                        .source?.[
                                                                                        field
                                                                                    ],
                                                                                )}
                                                                            </td>
                                                                            {action.existing && (
                                                                                <td className="p-1">
                                                                                    {displayValue(
                                                                                        field,
                                                                                        action
                                                                                            .existing[
                                                                                            field
                                                                                        ],
                                                                                    )}
                                                                                </td>
                                                                            )}
                                                                        </tr>
                                                                    ),
                                                                )}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </article>
                                    ))}
                            </div>
                            {review.plan.actions.length > shownActions && (
                                <Button
                                    className="mt-3"
                                    variant="outline"
                                    onClick={() =>
                                        setShownActions((count) => count + 50)
                                    }
                                >
                                    {t("portfolioImport.session.more")}
                                </Button>
                            )}
                        </Disclosure>
                        <p className="type-footnote text-label-secondary">
                            {t("portfolioImport.session.atomic")}
                        </p>
                        <Button
                            onClick={() => void commit()}
                            disabled={!canCommit || operation !== "idle"}
                        >
                            {t("portfolioImport.session.commit")}
                        </Button>
                    </section>
                )}
                {operation === "commit" && (
                    <p
                        role="status"
                        className="type-footnote text-label-secondary"
                    >
                        {t("portfolioImport.session.committing")}
                    </p>
                )}
                {result && (
                    <p role="status" className="type-body">
                        {t("portfolioImport.session.success", {
                            imported: result.imported,
                            adopted: result.adopted,
                            duplicates: Math.max(
                                0,
                                result.duplicates - result.adopted,
                            ),
                        })}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
