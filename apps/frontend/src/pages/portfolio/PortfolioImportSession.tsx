import { CloudUpload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
    DisclosureContent,
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
    listPortfolioImportBatches,
    type PortfolioReconciliationPlan,
    type PortfolioReconciliationPolicy,
    type PortfolioReconciliationMode,
    type ReviewedPortfolioImportResult,
    type PortfolioImportBatchPage,
} from "@/lib/api/portfolioImports";
import type { Account } from "@/types/api";
import {
    detectPortfolioImportFile,
    resolveDetectedPortfolioAccount,
    type DetectedPortfolioImport,
} from "./portfolioImportDetection";
import { portfolioImportPresetConfig } from "./portfolioImportPresets";
import { PortfolioImportHistory } from "./PortfolioImportHistory";

const STORAGE_KEY = "vision.portfolio-import.latest-session.v1";
const SETTINGS_STORAGE_KEY =
    "vision.portfolio-import.latest-review-settings.v1";
const retainedIbkrConfigSchema = z.object({
    format: z.literal("ibkr_transaction_history"),
});
function isRetainedIbkrBatch(batch: PortfolioImportBatchPage["items"][number]) {
    return (
        batch.adapter_name === "ibkr_transaction_history" ||
        retainedIbkrConfigSchema.safeParse(batch.custom_config).success
    );
}
const storedSessionSchema = z
    .array(
        z.object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(["reference", "existing"]).optional(),
            originalBatchId: z.number().int().positive().optional(),
            originalSourceName: z.string().optional(),
            accountId: z.number().int().positive(),
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
                        "native_receipts",
                    ]),
                    sourceAccountIdentities: z.array(z.string()),
                    presetKey: z.literal("ibkr_funding_history").optional(),
                })
                .optional(),
            transferDestinationAccountId: z
                .number()
                .int()
                .positive()
                .optional(),
            transferOriginAccountId: z.number().int().positive().optional(),
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
    kind?: "reference" | "existing";
    originalBatchId?: number;
    originalSourceName?: string;
    file?: File;
    detected?: DetectedPortfolioImport;
    accountId?: number;
    accountChosenManually?: boolean;
    adoptPolicy?: PortfolioReconciliationPolicy;
    transferDestinationAccountId?: number;
    transferOriginAccountId?: number;
    includedSymbols?: string;
    batchId?: number;
    previousBatchIds?: number[];
    status:
        "detecting" | "ready" | "staging" | "staged" | "error" | "completed";
    skipped?: number;
    rows?: number;
    sourceErrors?: number;
    error?: string;
}

function readSession(): Statement[] {
    try {
        const stored: unknown = JSON.parse(
            sessionStorage.getItem(STORAGE_KEY) ?? "[]",
        );
        const parsed = storedSessionSchema.safeParse(stored);
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

function persistSession(statements: Statement[]) {
    try {
        const staged = statements.filter(
            (item) => item.batchId && item.status === "staged",
        );
        if (!staged.length) sessionStorage.removeItem(STORAGE_KEY);
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
            kind: item.kind,
            originalBatchId: item.originalBatchId,
            source: item.detected?.source,
            presetKey: item.detected?.presetKey,
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
    reconciliationMode: z.enum([
        "full",
        "adopt_existing_only",
        "correct_existing_only",
        "record_in_kind_income_only",
        "record_cash_only",
    ]),
    policy: z.enum(["auto", "preserve_existing", "prefer_source"]),
    cashFundingPolicy: z.literal("own_account_transfer").optional(),
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
    native_receipts: "importPage.csvFile",
};
const actions = [
    "record_income",
    "insert",
    "adopt",
    "repair_duplicate",
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
const cashFields = ["date", "type", "amount", "currency", "memo"];
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
    reference_ambiguous_asset: "referenceAsset",
    reference_ambiguous_match: "referenceMatch",
    reference_account_mapping_conflict: "referenceAccount",
    reference_unmatched_event: "referenceEvent",
    reference_unmapped_portfolio: "referencePortfolio",
    reference_unproven_basis: "basis",
    reference_unproven_transfer_fee: "referenceFee",
    reference_existing_trade_conflict: "referenceTrade",
    unresolved_adjustment_kind: "adjustmentKind",
    unresolved_adjustment_basis: "adjustmentBasis",
    incomplete_adjustment: "adjustmentIncomplete",
    missing_adjustment_identity: "identity",
    unresolved_zero_yield_policy: "zeroYield",
    projected_history_conflict: "projectedHistory",
    cash_reconciliation_required: "cashScope",
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
    const [existingBatches, setExistingBatches] =
        useState<PortfolioImportBatchPage>();
    const [existingBatchId, setExistingBatchId] = useState("");
    const [existingLoading, setExistingLoading] = useState(false);
    const [policy, setPolicy] = useState<
        "auto" | PortfolioReconciliationPolicy
    >(initialSettings?.policy ?? "auto");
    const [reconciliationMode, setReconciliationMode] =
        useState<PortfolioReconciliationMode>(
            initialSettings?.reconciliationMode ?? "full",
        );
    const [cashConfirmedSourceKey, setCashConfirmedSourceKey] = useState<
        string | undefined
    >(
        initialSettings?.cashFundingPolicy
            ? initialSettings.sourceRoutingKey
            : undefined,
    );
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
            item.detected && !item.batchId && !item.accountChosenManually
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
                    item.accountId !== statementsRef.current[index].accountId,
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
    const kinesisOnly =
        statements.length > 0 &&
        statements.every(
            (item) =>
                !item.kind &&
                item.detected?.source === "kinesis" &&
                !item.includedSymbols?.trim(),
        );
    const attachmentEligible =
        kinesisOnly &&
        statements.every((item) => item.adoptPolicy !== "prefer_source");
    const correctionEligible =
        (kinesisOnly ||
            (statements.length > 0 &&
                statements.every(
                    (item) =>
                        !item.kind &&
                        item.detected?.source === "ibkr" &&
                        item.detected.presetKey === "ibkr_funding_history" &&
                        !item.includedSymbols?.trim(),
                ))) &&
        statements.every((item) => item.adoptPolicy !== "preserve_existing");
    const attachmentOnly = reconciliationMode === "adopt_existing_only";
    const correctionOnly = reconciliationMode === "correct_existing_only";
    const incomeOnly = reconciliationMode === "record_in_kind_income_only";
    const cashOnly = reconciliationMode === "record_cash_only";
    const existingOnly =
        attachmentOnly || correctionOnly || incomeOnly || cashOnly;
    const routingKey = sourceRoutingKey(statements);
    const cashFundingConfirmed = cashConfirmedSourceKey === routingKey;
    useEffect(() => {
        if (cashConfirmedSourceKey && cashConfirmedSourceKey !== routingKey)
            setCashConfirmedSourceKey(undefined);
    }, [cashConfirmedSourceKey, routingKey]);
    const scopeValid =
        (!attachmentOnly ||
            (attachmentEligible && policy === "preserve_existing")) &&
        (!correctionOnly ||
            (correctionEligible && policy === "prefer_source")) &&
        (!incomeOnly ||
            (attachmentEligible && policy === "preserve_existing")) &&
        (!cashOnly ||
            (attachmentEligible &&
                policy === "preserve_existing" &&
                cashFundingConfirmed));
    const scope = {
        batchIds: ids,
        ...(existingOnly ? { reconciliationScope: reconciliationMode } : {}),
        ...(policy === "auto" ? {} : { adoptPolicy: policy }),
        ...(cashOnly && cashFundingConfirmed
            ? { cashFundingPolicy: "own_account_transfer" as const }
            : {}),
        ...(statements.some(
            (item) => item.status === "staged" && item.adoptPolicy,
        )
            ? {
                  batchPolicies: statements
                      .filter(
                          (item) =>
                              item.status === "staged" && item.adoptPolicy,
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
                !checkpointIds.length ||
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
                    reconciliationMode,
                    policy,
                    ...(cashFundingConfirmed
                        ? { cashFundingPolicy: "own_account_transfer" }
                        : {}),
                }),
            );
        } catch {
            /* Session storage restrictions cannot prevent import review. */
        }
    }, [
        statements,
        routingKey,
        reconciliationMode,
        policy,
        cashFundingConfirmed,
    ]);
    const allStaged =
        statements.length > 0 &&
        statements.every((item) => item.status === "staged");
    const canStage =
        scopeValid &&
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
        scopeValid &&
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
        if (locked || !files.length) return;
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
                          accountId: value ? Number(value) : undefined,
                          accountChosenManually: true,
                          batchId: undefined,
                          status: "ready",
                          previousBatchIds: item.batchId
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
                          previousBatchIds: item.batchId
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
                              ? Number(value)
                              : undefined,
                          ...(item.detected?.source === "nexo"
                              ? {
                                    transferOriginAccountId: value
                                        ? Number(value)
                                        : undefined,
                                }
                              : {}),
                          batchId: undefined,
                          status: "ready",
                          rows: undefined,
                          sourceErrors: undefined,
                          previousBatchIds: item.batchId
                              ? [...(item.previousBatchIds ?? []), item.batchId]
                              : item.previousBatchIds,
                      }
                    : item,
            ),
        );
    };

    const loadExistingBatches = async (offset = 0) => {
        setExistingLoading(true);
        try {
            const page = await listPortfolioImportBatches(50, offset);
            if (mounted.current) {
                setExistingBatches(page);
                setExistingBatchId("");
            }
        } catch (failure) {
            if (mounted.current)
                setError(
                    failure instanceof Error &&
                        failure.name === "PortfolioImportResponseError"
                        ? t("portfolioImport.session.responseUnverified")
                        : apiErrorToMessage(failure, t),
                );
        } finally {
            if (mounted.current) setExistingLoading(false);
        }
    };
    const addExistingBatch = () => {
        const batch = existingBatches?.items.find(
            (item) => item.id === Number(existingBatchId),
        );
        if (
            !batch ||
            !isRetainedIbkrBatch(batch) ||
            !["complete", "complete_with_errors"].includes(batch.status) ||
            !accounts.some((account) => account.id === batch.account_id) ||
            statementsRef.current.some(
                (item) =>
                    item.batchId === batch.id ||
                    item.originalBatchId === batch.id,
            ) ||
            statementsRef.current.length >= 100
        )
            return;
        invalidate();
        updateStatements((previous) => [
            ...previous,
            {
                id: `existing-${batch.id}`,
                kind: "existing",
                name:
                    batch.source_filename ||
                    t("portfolioImport.session.batch", { id: batch.id }),
                batchId: batch.id,
                accountId: batch.account_id!,
                status: "staged",
                rows: batch.rows_total,
                sourceErrors: batch.rows_error,
            },
        ]);
        setExistingBatchId("");
    };
    const stage = async () => {
        if (!canStage || operation !== "idle") return;
        invalidate();
        setOperation("staging");
        setStopped(false);
        stopRequested.current = false;
        for (const item of statementsRef.current) {
            if (stopRequested.current) break;
            if (item.kind === "existing") continue;
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
                                  status: row.batchId ? "staged" : "error",
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
        if (!allStaged || !scopeValid || operation !== "idle") return;
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
        if (!canCommit || !review || operation !== "idle") return;
        setOperation("commit");
        setError(undefined);
        try {
            const committed = await commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: review.plan.planFingerprint,
            });
            setResult(committed);
            setReview(undefined);
            updateStatements((previous) =>
                previous.map((item) => ({
                    ...item,
                    // A partial commit keeps the whole reviewed source scope queued.
                    status:
                        committed.complete === false ? "staged" : "completed",
                    sourceErrors:
                        committed.complete === false
                            ? item.sourceErrors
                            : (committed.batches.find(
                                  (batch) => batch.batch_id === item.batchId,
                              )?.errors ?? item.sourceErrors),
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
    const accountName = (id: number) =>
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
                        setExistingBatches(undefined);
                        setExistingBatchId("");
                        updateStatements((previous) =>
                            previous.filter(
                                (item) =>
                                    item.batchId !== batchId &&
                                    item.originalBatchId !== batchId,
                            ),
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
                <Disclosure variant="card">
                    <DisclosureSummary padded>
                        {t("portfolioImport.session.existing.title")}
                    </DisclosureSummary>
                    <DisclosureContent className="space-y-3">
                        <p className="type-footnote text-label-secondary">
                            {t("portfolioImport.session.existing.hint")}
                        </p>
                        <Button
                            variant="outline"
                            disabled={locked || existingLoading}
                            onClick={() => void loadExistingBatches()}
                        >
                            {t("portfolioImport.session.existing.load")}
                        </Button>
                        {existingBatches && (
                            <>
                                <Label htmlFor="portfolio-existing-batch">
                                    {t(
                                        "portfolioImport.session.existing.choose",
                                    )}
                                </Label>
                                <Select
                                    value={toSelectValue(existingBatchId)}
                                    onValueChange={(value) =>
                                        setExistingBatchId(
                                            fromSelectValue(value),
                                        )
                                    }
                                >
                                    <SelectTrigger
                                        id="portfolio-existing-batch"
                                        disabled={locked || existingLoading}
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={SELECT_NONE}>
                                            {t(
                                                "portfolioImport.session.existing.unselected",
                                            )}
                                        </SelectItem>
                                        {existingBatches.items
                                            .filter(
                                                (batch) =>
                                                    isRetainedIbkrBatch(
                                                        batch,
                                                    ) &&
                                                    [
                                                        "complete",
                                                        "complete_with_errors",
                                                    ].includes(batch.status) &&
                                                    accounts.some(
                                                        (account) =>
                                                            account.id ===
                                                            batch.account_id,
                                                    ) &&
                                                    !statements.some(
                                                        (item) =>
                                                            item.batchId ===
                                                                batch.id ||
                                                            item.originalBatchId ===
                                                                batch.id,
                                                    ),
                                            )
                                            .map((batch) => (
                                                <SelectItem
                                                    key={batch.id}
                                                    value={String(batch.id)}
                                                >
                                                    {t(
                                                        "portfolioImport.session.existing.option",
                                                        {
                                                            name:
                                                                batch.source_filename ||
                                                                batch.adapter_name,
                                                            id: batch.id,
                                                            account:
                                                                accountName(
                                                                    batch.account_id!,
                                                                ),
                                                            status: t(
                                                                `portfolioImport.session.existing.status.${batch.status}`,
                                                            ),
                                                        },
                                                    )}
                                                </SelectItem>
                                            ))}
                                    </SelectContent>
                                </Select>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={
                                            locked ||
                                            !existingBatchId ||
                                            statements.length >= 100
                                        }
                                        onClick={addExistingBatch}
                                    >
                                        {t(
                                            "portfolioImport.session.existing.add",
                                        )}
                                    </Button>
                                    {existingBatches.offset > 0 && (
                                        <Button
                                            variant="ghost"
                                            disabled={locked || existingLoading}
                                            onClick={() =>
                                                void loadExistingBatches(
                                                    Math.max(
                                                        0,
                                                        existingBatches.offset -
                                                            50,
                                                    ),
                                                )
                                            }
                                        >
                                            {t(
                                                "portfolioImport.session.existing.newer",
                                            )}
                                        </Button>
                                    )}
                                    {existingBatches.offset +
                                        existingBatches.items.length <
                                        existingBatches.total && (
                                        <Button
                                            variant="ghost"
                                            disabled={locked || existingLoading}
                                            onClick={() =>
                                                void loadExistingBatches(
                                                    existingBatches.offset + 50,
                                                )
                                            }
                                        >
                                            {t(
                                                "portfolioImport.session.existing.older",
                                            )}
                                        </Button>
                                    )}
                                </div>
                            </>
                        )}
                    </DisclosureContent>
                </Disclosure>
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
                                            {item.kind === "existing" ||
                                            item.kind === "reference"
                                                ? t(
                                                      "portfolioImport.session.existing.source",
                                                  )
                                                : item.detected
                                                  ? t(
                                                        item.detected
                                                            .presetKey ===
                                                            "ibkr_funding_history"
                                                            ? "portfolioImport.ibkrFundingParser"
                                                            : sourceLabels[
                                                                  item.detected
                                                                      .source
                                                              ],
                                                    )
                                                  : t(
                                                        "portfolioImport.session.detecting",
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
                                                item.accountId
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
                                {item.detected && !item.accountId && (
                                    <p
                                        role="alert"
                                        className="type-footnote text-destructive"
                                    >
                                        {t(
                                            "portfolioImport.session.accountRequired",
                                        )}
                                    </p>
                                )}
                                {item.detected && (
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
                                                existingOnly ||
                                                item.detected.source ===
                                                    "native_receipts" ||
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
                                            <SelectItem
                                                value="preserve_existing"
                                                disabled={correctionOnly}
                                            >
                                                {t(
                                                    "portfolioImport.session.preserve",
                                                )}
                                            </SelectItem>
                                            <SelectItem
                                                value="prefer_source"
                                                disabled={
                                                    attachmentOnly ||
                                                    incomeOnly ||
                                                    cashOnly
                                                }
                                            >
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
                                {item.batchId && (
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
                                {item.originalBatchId && (
                                    <p className="type-caption text-label-secondary">
                                        {t(
                                            "portfolioImport.session.existing.readonly",
                                        )}{" "}
                                        <Link
                                            className="underline"
                                            to={`/portfolio/import/${item.originalBatchId}/review`}
                                        >
                                            {t(
                                                "portfolioImport.session.batch",
                                                { id: item.originalBatchId },
                                            )}
                                        </Link>
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
                    <Label htmlFor="portfolio-session-scope">
                        {t("portfolioImport.session.scope")}
                    </Label>
                    <Select
                        value={reconciliationMode}
                        onValueChange={(value) => {
                            invalidate();
                            const next = value as PortfolioReconciliationMode;
                            setReconciliationMode(next);
                            if (
                                next === "adopt_existing_only" ||
                                next === "record_in_kind_income_only" ||
                                next === "record_cash_only"
                            )
                                setPolicy("preserve_existing");
                            if (next === "correct_existing_only")
                                setPolicy("prefer_source");
                        }}
                    >
                        <SelectTrigger
                            id="portfolio-session-scope"
                            disabled={locked}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="full">
                                {t("portfolioImport.session.fullHistory")}
                            </SelectItem>
                            <SelectItem
                                value="record_cash_only"
                                disabled={!attachmentEligible}
                            >
                                {t("portfolioImport.session.recordCash")}
                            </SelectItem>
                            <SelectItem
                                value="record_in_kind_income_only"
                                disabled={!attachmentEligible}
                            >
                                {t(
                                    "portfolioImport.session.recordInKindIncome",
                                )}
                            </SelectItem>
                            <SelectItem
                                value="correct_existing_only"
                                disabled={!correctionEligible}
                            >
                                {t(
                                    "portfolioImport.session.correctExistingRecords",
                                )}
                            </SelectItem>
                            <SelectItem
                                value="adopt_existing_only"
                                disabled={!attachmentEligible}
                            >
                                {t(
                                    "portfolioImport.session.attachSourceRecords",
                                )}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="type-footnote text-label-secondary">
                        {t(
                            cashOnly
                                ? "portfolioImport.session.cashHint"
                                : incomeOnly
                                  ? "portfolioImport.session.incomeHint"
                                  : correctionOnly
                                    ? "portfolioImport.session.correctionHint"
                                    : attachmentOnly
                                      ? "portfolioImport.session.attachmentHint"
                                      : "portfolioImport.session.fullHistoryHint",
                        )}
                    </p>
                    {cashOnly && (
                        <div className="space-y-2 type-footnote">
                            <div className="flex items-start gap-2">
                                <Checkbox
                                    id="portfolio-cash-funding-confirmation"
                                    className="mt-0.5"
                                    checked={cashFundingConfirmed}
                                    disabled={locked}
                                    onCheckedChange={(checked) => {
                                        invalidate();
                                        setCashConfirmedSourceKey(
                                            checked === true
                                                ? routingKey
                                                : undefined,
                                        );
                                    }}
                                />
                                <Label
                                    htmlFor="portfolio-cash-funding-confirmation"
                                    className="cursor-pointer type-body font-normal leading-snug"
                                >
                                    {t(
                                        "portfolioImport.session.cashFundingConfirmation",
                                    )}
                                </Label>
                            </div>
                            <p className="text-label-secondary">
                                {t("portfolioImport.session.cashFundingHint")}
                            </p>
                        </div>
                    )}
                    {existingOnly && !scopeValid && (
                        <p
                            role="alert"
                            className="type-footnote text-destructive"
                        >
                            {t(
                                cashOnly
                                    ? "portfolioImport.session.cashUnavailable"
                                    : incomeOnly
                                      ? "portfolioImport.session.incomeUnavailable"
                                      : correctionOnly
                                        ? "portfolioImport.session.correctionUnavailable"
                                        : "portfolioImport.session.attachmentUnavailable",
                            )}
                        </p>
                    )}
                </div>
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
                            disabled={locked || existingOnly}
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
                        {t(
                            cashOnly
                                ? "portfolioImport.session.cashPolicyHint"
                                : incomeOnly
                                  ? "portfolioImport.session.incomePolicyHint"
                                  : correctionOnly
                                    ? "portfolioImport.session.correctionPolicyHint"
                                    : `portfolioImport.session.policyHint.${policy}`,
                        )}
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
                        disabled={
                            !allStaged || !scopeValid || operation !== "idle"
                        }
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
                        {existingOnly && (
                            <p className="type-body">
                                {t(
                                    cashOnly
                                        ? "portfolioImport.session.cashCounts"
                                        : incomeOnly
                                          ? "portfolioImport.session.incomeCounts"
                                          : correctionOnly
                                            ? "portfolioImport.session.correctionCounts"
                                            : "portfolioImport.session.attachmentCounts",
                                    {
                                        adopted: review.plan.summary.adopt ?? 0,
                                        events: review.plan.summary.cash ?? 0,
                                        recorded:
                                            (cashOnly
                                                ? review.plan.actions
                                                      .filter(
                                                          (action) =>
                                                              action.action ===
                                                              "cash",
                                                      )
                                                      .reduce(
                                                          (count, action) =>
                                                              count +
                                                              (action.cashProof
                                                                  ?.componentCount ??
                                                                  0),
                                                          0,
                                                      )
                                                : review.plan.summary
                                                      .record_income) ?? 0,
                                        pending: review.plan.pending ?? 0,
                                    },
                                )}
                            </p>
                        )}
                        {correctionOnly &&
                            review.plan.actions.some(
                                (action) => action.dateProof,
                            ) && (
                                <p className="type-footnote text-label-secondary">
                                    {t(
                                        "portfolioImport.session.groupDateCorrection",
                                    )}
                                </p>
                            )}
                        {(review.plan.pending ?? 0) > 0 && (
                            <div className="space-y-2 type-footnote">
                                <p>{t("portfolioImport.session.deferred")}</p>
                                <ul className="space-y-1">
                                    {Object.entries(
                                        review.plan.deferredCounts ?? {},
                                    )
                                        .filter(([, count]) => count > 0)
                                        .map(([reason, count]) => (
                                            <li key={reason}>
                                                {t(
                                                    `portfolioImport.session.deferredKinds.${["dividend", "gift", "sell", "cash", "asset_transfer", "asset_adjustment"].includes(reason) ? reason : "unsupported"}`,
                                                )}
                                                : {count}
                                            </li>
                                        ))}
                                </ul>
                            </div>
                        )}
                        <dl className="grid grid-cols-2 gap-3 type-body sm:grid-cols-3">
                            {actions
                                .filter(
                                    (action) => review.plan.summary[action] > 0,
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
                                                {blocker.rowOrdinal && (
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
                                            {action.existingTransactionId && (
                                                <p className="type-caption text-label-secondary">
                                                    {t(
                                                        "portfolioImport.session.existingId",
                                                        {
                                                            id: action.existingTransactionId,
                                                        },
                                                    )}
                                                </p>
                                            )}
                                            {action.cashProof && (
                                                <p className="mt-1 type-caption text-label-secondary">
                                                    {t(
                                                        `portfolioImport.session.cashKinds.${action.cashProof.eventKind}`,
                                                    )}
                                                </p>
                                            )}
                                            {action.cashValues && (
                                                <dl className="mt-2 grid grid-cols-2 gap-2 type-caption">
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.fields.date",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {action.cashValues.date}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.fields.amount",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {
                                                            action.cashValues
                                                                .amount
                                                        }{" "}
                                                        {
                                                            action.cashValues
                                                                .currency
                                                        }
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.cashAccount",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {accountName(
                                                            action.cashValues
                                                                .accountId,
                                                        )}
                                                    </dd>
                                                    <dt>
                                                        {t(
                                                            "portfolioImport.session.cashTreatment",
                                                        )}
                                                    </dt>
                                                    <dd>
                                                        {t(
                                                            action.cashValues
                                                                .isTransfer
                                                                ? "portfolioImport.session.cashTransfer"
                                                                : "portfolioImport.session.cashExpense",
                                                        )}
                                                    </dd>
                                                </dl>
                                            )}
                                            {action.cashFeeValues && (
                                                <p className="mt-2 type-caption">
                                                    {t(
                                                        "portfolioImport.session.cashFeeExpense",
                                                        {
                                                            amount: action
                                                                .cashFeeValues
                                                                .amount,
                                                            currency:
                                                                action
                                                                    .cashFeeValues
                                                                    .currency,
                                                        },
                                                    )}
                                                </p>
                                            )}
                                            {action.existingCashFeeTransactionId && (
                                                <p className="mt-1 type-caption text-label-secondary">
                                                    {t(
                                                        "portfolioImport.session.cashFeeExistingId",
                                                        {
                                                            id: action.existingCashFeeTransactionId,
                                                        },
                                                    )}
                                                </p>
                                            )}
                                            {action.action ===
                                                "repair_duplicate" && (
                                                <p className="mt-1 type-caption text-label-secondary">
                                                    {t(
                                                        "portfolioImport.session.repairHint",
                                                        {
                                                            existing:
                                                                action.existingTransactionId!,
                                                            imported:
                                                                action.importedTransactionId!,
                                                            batch: action.originalBatchId!,
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
                                                                {action.importedExisting && (
                                                                    <th className="p-1">
                                                                        {t(
                                                                            "portfolioImport.session.importedValues",
                                                                        )}
                                                                    </th>
                                                                )}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {(action.isCash
                                                                ? cashFields
                                                                : fields
                                                            )
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
                                                                            null ||
                                                                        action
                                                                            .importedExisting?.[
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
                                                                                    field ===
                                                                                        "memo"
                                                                                        ? "txPage.field.description"
                                                                                        : action.isCash &&
                                                                                            field ===
                                                                                                "amount"
                                                                                          ? "txPage.field.amount"
                                                                                          : `portfolioImport.session.fields.${field}`,
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
                                                                            {action.importedExisting && (
                                                                                <td className="p-1">
                                                                                    {displayValue(
                                                                                        field,
                                                                                        action
                                                                                            .importedExisting[
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
                            {t(
                                cashOnly
                                    ? "portfolioImport.session.cashAtomic"
                                    : incomeOnly
                                      ? "portfolioImport.session.incomeAtomic"
                                      : correctionOnly
                                        ? "portfolioImport.session.correctionAtomic"
                                        : attachmentOnly
                                          ? "portfolioImport.session.attachmentAtomic"
                                          : "portfolioImport.session.atomic",
                            )}
                        </p>
                        <Button
                            onClick={() => void commit()}
                            disabled={!canCommit || operation !== "idle"}
                        >
                            {t(
                                cashOnly
                                    ? "portfolioImport.session.recordReviewedCash"
                                    : incomeOnly
                                      ? "portfolioImport.session.recordReviewedIncome"
                                      : correctionOnly
                                        ? "portfolioImport.session.correctReviewed"
                                        : attachmentOnly
                                          ? "portfolioImport.session.attachReviewed"
                                          : "portfolioImport.session.commit",
                            )}
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
                        {t(
                            result.reconciliationScope === "record_cash_only"
                                ? result.complete === false
                                    ? "portfolioImport.session.cashPartialSuccess"
                                    : "portfolioImport.session.cashSuccess"
                                : result.reconciliationScope ===
                                    "record_in_kind_income_only"
                                  ? result.complete === false
                                      ? "portfolioImport.session.incomePartialSuccess"
                                      : "portfolioImport.session.incomeSuccess"
                                  : result.complete === false
                                    ? "portfolioImport.session.partialSuccess"
                                    : "portfolioImport.session.success",
                            {
                                imported: result.imported,
                                adopted: result.adopted,
                                repaired: result.repaired,
                                pending: result.pending ?? 0,
                                recordedIncome: result.recordedIncome ?? 0,
                                recordedCash: result.recordedCash ?? 0,
                                duplicates: Math.max(
                                    0,
                                    result.duplicates -
                                        result.adopted -
                                        result.repaired,
                                ),
                            },
                        )}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
