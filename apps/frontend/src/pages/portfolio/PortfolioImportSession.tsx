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
import { PortfolioBrokerField } from "@/features/portfolio/PortfolioBrokerField";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    importPortfolioCSVWithProgress,
    getPortfolioImportPreview,
    previewPortfolioImportReconciliation,
    commitReviewedPortfolioImports,
    applyPortfolioImportReference,
    portfolioReferenceResultSchema,
    listPortfolioImportBatches,
    type PortfolioReconciliationPlan,
    type PortfolioReconciliationPolicy,
    type ReviewedPortfolioImportResult,
    type PortfolioReferenceResult,
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
const REFERENCE_STORAGE_KEY = "vision.portfolio-import.latest-reference.v1";
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
                    ]),
                    sourceAccountIdentities: z.array(z.string()),
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

const storedReferenceSchema = z.object({
    name: z.string().min(1),
    placeholderBasisPolicy: z.literal("zero").optional(),
    applied: portfolioReferenceResultSchema.optional(),
});
interface Reference {
    name?: string;
    file?: File;
    placeholderBasisPolicy?: "zero";
    applied?: PortfolioReferenceResult;
}
function readReference(): Reference {
    try {
        const stored: unknown = JSON.parse(
            sessionStorage.getItem(REFERENCE_STORAGE_KEY) ?? "{}",
        );
        const parsed = storedReferenceSchema.safeParse(stored);
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
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

const sourceLabels = {
    ibkr: "portfolioImport.ibkrParser",
    kinesis: "portfolioImport.kinesisParser",
    nexo: "portfolioImport.nexoParser",
    nexo_pro: "portfolioImport.nexoProParser",
    saxo: "portfolioImport.saxoParser",
};
const actions = [
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
};

interface Props {
    accounts: readonly Account[];
}

export function PortfolioImportSession({ accounts }: Props) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const [statements, setStatements] = useState<Statement[]>(readSession);
    const statementsRef = useRef(statements);
    const [reference, setReference] = useState<Reference>(readReference);
    const referenceRef = useRef(reference);
    const [existingBatches, setExistingBatches] =
        useState<PortfolioImportBatchPage>();
    const [existingBatchId, setExistingBatchId] = useState("");
    const [existingLoading, setExistingLoading] = useState(false);
    const [policy, setPolicy] = useState<
        "auto" | PortfolioReconciliationPolicy
    >("auto");
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
        ) || Boolean(reference.name && !reference.applied),
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
    const updateReference = useCallback((next: Reference) => {
        referenceRef.current = next;
        try {
            if (next.name) {
                const { file: _file, ...stored } = next;
                sessionStorage.setItem(
                    REFERENCE_STORAGE_KEY,
                    JSON.stringify(stored),
                );
            } else sessionStorage.removeItem(REFERENCE_STORAGE_KEY);
        } catch {
            /* Storage restrictions cannot prevent staging. */
        }
        if (mounted.current) setReference(next);
    }, []);
    const restageReferenceScope = (previous: Statement[]) =>
        previous
            .filter((item) => item.kind !== "reference" || item.originalBatchId)
            .map((item, index): Statement => ({
                ...item,
                ...(item.originalBatchId
                    ? {
                          id: `existing-${item.originalBatchId}`,
                          name: item.originalSourceName ?? item.name,
                          kind: "existing" as const,
                          originalBatchId: undefined,
                          originalSourceName: undefined,
                      }
                    : {}),
                batchId:
                    item.originalBatchId ??
                    (item.kind === "existing" ? item.batchId : undefined),
                previousBatchIds: [
                    ...new Set([
                        ...(item.previousBatchIds ?? []),
                        ...(item.batchId && item.kind !== "existing"
                            ? [item.batchId]
                            : []),
                        ...(index === 0
                            ? previous
                                  .filter(
                                      (row) =>
                                          row.kind === "reference" &&
                                          row.batchId,
                                  )
                                  .map((row) => row.batchId!)
                            : []),
                    ]),
                ],
                status:
                    item.kind === "existing" || item.originalBatchId
                        ? "ready"
                        : item.file
                          ? item.detected
                              ? "ready"
                              : "detecting"
                          : "error",
                rows: undefined,
                sourceErrors: undefined,
                error:
                    item.kind === "existing" ||
                    item.originalBatchId ||
                    item.file
                        ? undefined
                        : t("portfolioImport.session.reference.reattach"),
            }));
    const invalidateReferenceScope = (previous: Statement[]) => {
        if (!referenceRef.current.name) return previous;
        updateReference({
            ...referenceRef.current,
            applied: undefined,
        });
        return restageReferenceScope(previous);
    };
    const changeReference = (file: File | undefined) => {
        invalidate();
        updateStatements((previous) => restageReferenceScope(previous));
        updateReference(
            file
                ? {
                      name: file.name,
                      file,
                      placeholderBasisPolicy: reference.placeholderBasisPolicy,
                  }
                : {},
        );
    };
    const changePlaceholderPolicy = (value: string) => {
        invalidate();
        updateStatements((previous) => invalidateReferenceScope(previous));
        updateReference({
            ...referenceRef.current,
            placeholderBasisPolicy: value === "zero" ? "zero" : undefined,
            applied: undefined,
        });
    };
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
    const scope = {
        batchIds: ids,
        ...(policy === "auto" ? {} : { adoptPolicy: policy }),
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
    const scopeKey = JSON.stringify(scope);
    const referenceScopeVerified =
        !reference.name ||
        Boolean(
            reference.applied &&
            reference.placeholderBasisPolicy === "zero" &&
            JSON.stringify(
                [...reference.applied.batch_ids].sort((a, b) => a - b),
            ) === JSON.stringify(ids),
        );
    const allStaged =
        statements.length > 0 &&
        statements.every((item) => item.status === "staged") &&
        referenceScopeVerified;
    const canStage =
        statements.length > 0 &&
        (statements.some(
            (item) => item.kind !== "existing" && item.status !== "staged",
        ) ||
            Boolean(reference.file && !reference.applied)) &&
        (!reference.name ||
            (Boolean(reference.file) &&
                reference.placeholderBasisPolicy === "zero")) &&
        statements.every(
            (item) =>
                item.status === "staged" ||
                (item.kind === "existing" &&
                    item.batchId &&
                    reference.name &&
                    accounts.some(
                        (account) => account.id === item.accountId,
                    )) ||
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
        (!reference.applied || reference.applied.blockers.length === 0) &&
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
                : invalidateReferenceScope(previous)),
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
            invalidateReferenceScope(previous).map((item) =>
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
            invalidateReferenceScope(previous).map((item) =>
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
            invalidateReferenceScope(previous).map((item) =>
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
            ...invalidateReferenceScope(previous),
            {
                id: `existing-${batch.id}`,
                kind: "existing",
                name:
                    batch.source_filename ||
                    t("portfolioImport.session.batch", { id: batch.id }),
                batchId: batch.id,
                accountId: batch.account_id!,
                status: "ready",
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
                    ...portfolioImportPresetConfig(item.detected!.source)!,
                    accountId: item.accountId,
                    includedSymbols: item.includedSymbols,
                    transferDestinationAccountId:
                        item.transferDestinationAccountId,
                    transferOriginAccountId: item.transferOriginAccountId,
                    ...(item.detected?.source === "kinesis" &&
                    referenceRef.current.file &&
                    referenceRef.current.placeholderBasisPolicy === "zero"
                        ? { yieldBasisPolicy: "zero" as const }
                        : {}),
                };
                const pending = importPortfolioCSVWithProgress(
                    item.file!,
                    config,
                    config.format!,
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
        const currentReference = referenceRef.current;
        if (
            !stopRequested.current &&
            currentReference.file &&
            currentReference.placeholderBasisPolicy === "zero" &&
            !currentReference.applied &&
            statementsRef.current.every(
                (item) => item.status === "staged" || item.kind === "existing",
            )
        ) {
            try {
                const sourceStatements = statementsRef.current.filter(
                    (item) => item.kind !== "reference",
                );
                const applied = await applyPortfolioImportReference({
                    file: currentReference.file,
                    batchIds: sourceStatements
                        .map((item) => item.batchId!)
                        .sort((a, b) => a - b),
                    placeholderBasisPolicy: "zero",
                });
                const accountScope = new Set(
                    sourceStatements
                        .flatMap((item) => [
                            item.accountId,
                            item.transferOriginAccountId,
                            item.transferDestinationAccountId,
                        ])
                        .filter((id): id is number => id !== undefined),
                );
                if (
                    applied.supplemental_batches.some(
                        (batch) => !accountScope.has(batch.account_id),
                    )
                ) {
                    const failure = new Error(
                        "Unverified portfolio reference account scope",
                    );
                    failure.name = "PortfolioImportResponseError";
                    throw failure;
                }
                updateStatements((previous) => [
                    ...previous.filter(
                        (item) =>
                            !applied.replacement_batches.some(
                                (replacement) =>
                                    replacement.original_batch_id ===
                                    item.batchId,
                            ),
                    ),
                    ...applied.supplemental_batches.map((batch): Statement => {
                        const replacement = applied.replacement_batches.find(
                            (entry) => entry.review_batch_id === batch.batch_id,
                        );
                        const original =
                            replacement &&
                            sourceStatements.find(
                                (item) =>
                                    item.batchId ===
                                    replacement.original_batch_id,
                            );
                        return {
                            id: `reference-${batch.batch_id}`,
                            kind: "reference",
                            name: batch.source_filename,
                            accountId: batch.account_id,
                            batchId: batch.batch_id,
                            status: "staged",
                            rows: batch.rows_total,
                            originalBatchId: replacement?.original_batch_id,
                            originalSourceName: original?.name,
                            adoptPolicy: original?.adoptPolicy,
                            previousBatchIds: original?.previousBatchIds,
                        };
                    }),
                ]);
                updateReference({ ...currentReference, applied });
            } catch (failure) {
                if (mounted.current)
                    setError(
                        failure instanceof Error &&
                            failure.name === "PortfolioImportResponseError"
                            ? t("portfolioImport.session.reference.unverified")
                            : apiErrorToMessage(failure, t),
                    );
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
                previous.map((item) => ({ ...item, status: "completed" })),
            );
            updateReference({});
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
                            invalidateReferenceScope(
                                previous.filter(
                                    (item) =>
                                        item.batchId !== batchId &&
                                        item.originalBatchId !== batchId,
                                ),
                            ),
                        );
                    }}
                />
                <div
                    className="rounded-lg border border-dashed p-4"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        addFiles(Array.from(event.dataTransfer.files));
                    }}
                >
                    <Label htmlFor="portfolio-session-files">
                        {t("portfolioImport.session.files")}
                    </Label>
                    <Input
                        id="portfolio-session-files"
                        type="file"
                        accept=".csv,.xlsx"
                        multiple
                        disabled={locked}
                        className="mt-2"
                        onChange={(event) => {
                            addFiles(Array.from(event.target.files ?? []));
                            event.target.value = "";
                        }}
                    />
                </div>
                <details
                    className="rounded-lg border p-4"
                    open={Boolean(reference.name)}
                >
                    <summary className="cursor-pointer text-sm font-medium">
                        {t("portfolioImport.session.reference.title")}
                    </summary>
                    <div className="mt-3 space-y-3">
                        <p className="text-sm text-muted-foreground">
                            {t("portfolioImport.session.reference.hint")}
                        </p>
                        <Label htmlFor="portfolio-session-reference">
                            {t("portfolioImport.session.reference.file")}
                        </Label>
                        <Input
                            id="portfolio-session-reference"
                            type="file"
                            accept=".xml"
                            disabled={locked}
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) changeReference(file);
                                event.target.value = "";
                            }}
                        />
                        {reference.name && (
                            <>
                                <div className="flex items-center justify-between gap-3">
                                    <p className="break-words text-sm">
                                        {reference.name}
                                    </p>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={locked}
                                        onClick={() =>
                                            changeReference(undefined)
                                        }
                                    >
                                        {t(
                                            "portfolioImport.session.reference.remove",
                                        )}
                                    </Button>
                                </div>
                                <Label htmlFor="portfolio-placeholder-policy">
                                    {t(
                                        "portfolioImport.session.reference.placeholderPolicy",
                                    )}
                                </Label>
                                <select
                                    id="portfolio-placeholder-policy"
                                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                    value={
                                        reference.placeholderBasisPolicy ?? ""
                                    }
                                    disabled={locked}
                                    onChange={(event) =>
                                        changePlaceholderPolicy(
                                            event.target.value,
                                        )
                                    }
                                >
                                    <option value="">
                                        {t(
                                            "portfolioImport.session.reference.choosePolicy",
                                        )}
                                    </option>
                                    <option value="zero">
                                        {t(
                                            "portfolioImport.session.reference.zeroPolicy",
                                        )}
                                    </option>
                                </select>
                                <p className="text-xs text-muted-foreground">
                                    {t(
                                        "portfolioImport.session.reference.zeroHint",
                                    )}
                                </p>
                                {!reference.applied && !reference.file && (
                                    <p
                                        role="alert"
                                        className="text-sm text-destructive"
                                    >
                                        {t(
                                            "portfolioImport.session.reference.reattach",
                                        )}
                                    </p>
                                )}
                                {operation === "staging" &&
                                    statements.every(
                                        (item) =>
                                            item.status === "staged" ||
                                            item.kind === "existing",
                                    ) &&
                                    !reference.applied && (
                                        <p
                                            role="status"
                                            className="text-sm text-muted-foreground"
                                        >
                                            {t(
                                                "portfolioImport.session.reference.staging",
                                            )}
                                        </p>
                                    )}
                                {reference.applied && (
                                    <>
                                        {!referenceScopeVerified && (
                                            <p
                                                role="alert"
                                                className="text-sm text-destructive"
                                            >
                                                {t(
                                                    "portfolioImport.session.reference.unverified",
                                                )}
                                            </p>
                                        )}
                                        <p role="status" className="text-sm">
                                            {t(
                                                "portfolioImport.session.reference.staged",
                                                {
                                                    matched:
                                                        reference.applied
                                                            .matched_reference_rows,
                                                    corrections:
                                                        reference.applied
                                                            .source_corrections,
                                                    batches:
                                                        reference.applied
                                                            .supplemental_batches
                                                            .length,
                                                },
                                            )}
                                        </p>
                                        {reference.applied.blockers.length >
                                            0 && (
                                            <div
                                                role="alert"
                                                className="space-y-1 text-sm text-destructive"
                                            >
                                                <p>
                                                    {t(
                                                        "portfolioImport.session.reference.blocked",
                                                    )}
                                                </p>
                                                <ul>
                                                    {reference.applied.blockers.map(
                                                        (blocker, index) => (
                                                            <li
                                                                key={`${blocker.reason}-${index}`}
                                                            >
                                                                {blocker.rowOrdinal && (
                                                                    <>
                                                                        {t(
                                                                            "portfolioImport.session.row",
                                                                            {
                                                                                n: blocker.rowOrdinal,
                                                                            },
                                                                        )}
                                                                        :{" "}
                                                                    </>
                                                                )}
                                                                {t(
                                                                    `portfolioImport.session.blockers.${blockerKeys[blocker.reason] ?? "other"}`,
                                                                )}
                                                            </li>
                                                        ),
                                                    )}
                                                </ul>
                                            </div>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </details>
                <details className="rounded-lg border p-4">
                    <summary className="cursor-pointer text-sm font-medium">
                        {t("portfolioImport.session.existing.title")}
                    </summary>
                    <div className="mt-3 space-y-3">
                        <p className="text-sm text-muted-foreground">
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
                                <select
                                    id="portfolio-existing-batch"
                                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                    value={existingBatchId}
                                    disabled={locked || existingLoading}
                                    onChange={(event) =>
                                        setExistingBatchId(event.target.value)
                                    }
                                >
                                    <option value="">
                                        {t(
                                            "portfolioImport.session.existing.unselected",
                                        )}
                                    </option>
                                    {existingBatches.items
                                        .filter(
                                            (batch) =>
                                                isRetainedIbkrBatch(batch) &&
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
                                            <option
                                                key={batch.id}
                                                value={batch.id}
                                            >
                                                {t(
                                                    "portfolioImport.session.existing.option",
                                                    {
                                                        name:
                                                            batch.source_filename ||
                                                            batch.adapter_name,
                                                        id: batch.id,
                                                        account: accountName(
                                                            batch.account_id!,
                                                        ),
                                                        status: t(
                                                            `portfolioImport.session.existing.status.${batch.status}`,
                                                        ),
                                                    },
                                                )}
                                            </option>
                                        ))}
                                </select>
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
                    </div>
                </details>
                {statements.length > 0 && (
                    <ul className="divide-y rounded-lg border">
                        {statements.map((item) => (
                            <li key={item.id} className="space-y-3 p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="break-words text-sm font-medium">
                                            {item.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {item.originalBatchId
                                                ? t(
                                                      "portfolioImport.session.existing.managed",
                                                  )
                                                : item.kind === "existing"
                                                  ? t(
                                                        "portfolioImport.session.existing.source",
                                                    )
                                                  : item.kind === "reference"
                                                    ? t(
                                                          "portfolioImport.session.reference.supplemental",
                                                      )
                                                    : item.detected
                                                      ? t(
                                                            sourceLabels[
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
                                                invalidateReferenceScope(
                                                    previous,
                                                ).filter(
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
                                        className="text-sm text-destructive"
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
                                        <p className="text-sm text-muted-foreground">
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
                                    <select
                                        id={`policy-${item.id}`}
                                        aria-label={t(
                                            "portfolioImport.session.policyForFile",
                                            { name: item.name },
                                        )}
                                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                        value={item.adoptPolicy ?? ""}
                                        disabled={
                                            locked ||
                                            item.status === "completed"
                                        }
                                        onChange={(event) =>
                                            changeStatementPolicy(
                                                item.id,
                                                event.target.value,
                                            )
                                        }
                                    >
                                        <option value="">
                                            {t(
                                                "portfolioImport.session.useSessionPolicy",
                                            )}
                                        </option>
                                        <option value="preserve_existing">
                                            {t(
                                                "portfolioImport.session.preserve",
                                            )}
                                        </option>
                                        <option value="prefer_source">
                                            {t(
                                                "portfolioImport.session.source",
                                            )}
                                        </option>
                                    </select>
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
                                            <select
                                                id={`transfer-${item.id}`}
                                                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                                value={
                                                    item.detected.source !==
                                                        "nexo" ||
                                                    item.transferOriginAccountId ===
                                                        item.transferDestinationAccountId
                                                        ? (item.transferDestinationAccountId ??
                                                          "")
                                                        : ""
                                                }
                                                disabled={
                                                    locked ||
                                                    !item.file ||
                                                    item.status === "completed"
                                                }
                                                onChange={(event) =>
                                                    changeTransferAccount(
                                                        item.id,
                                                        event.target.value,
                                                    )
                                                }
                                            >
                                                <option value="">
                                                    {t(
                                                        item.detected.source ===
                                                            "nexo"
                                                            ? "portfolioImport.session.custodyUnassigned"
                                                            : "portfolioImport.session.transferUnassigned",
                                                    )}
                                                </option>
                                                {accounts
                                                    .filter(
                                                        (account) =>
                                                            account.id !==
                                                            item.accountId,
                                                    )
                                                    .map((account) => (
                                                        <option
                                                            key={account.id}
                                                            value={account.id}
                                                        >
                                                            {account.display_name ||
                                                                account.name}
                                                        </option>
                                                    ))}
                                            </select>
                                            <p className="text-xs text-muted-foreground">
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
                                        className="text-sm text-muted-foreground"
                                    >
                                        {t("portfolioImport.session.staging")}
                                    </p>
                                )}
                                {item.batchId && (
                                    <p className="text-sm text-muted-foreground">
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
                                    <p className="text-xs text-muted-foreground">
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
                                        className="text-xs text-muted-foreground"
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
                                        className="text-sm text-destructive"
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
                    <select
                        id="portfolio-session-policy"
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={policy}
                        disabled={locked}
                        onChange={(event) => {
                            invalidate();
                            setPolicy(event.target.value as typeof policy);
                        }}
                    >
                        <option value="auto">
                            {t("portfolioImport.session.auto")}
                        </option>
                        <option value="preserve_existing">
                            {t("portfolioImport.session.preserve")}
                        </option>
                        <option value="prefer_source">
                            {t("portfolioImport.session.source")}
                        </option>
                    </select>
                    <p className="text-sm text-muted-foreground">
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
                                updateReference({});
                            }}
                        >
                            {t("portfolioImport.session.clear")}
                        </Button>
                    )}
                </div>
                {stopped && (
                    <p role="status" className="text-sm text-muted-foreground">
                        {t("portfolioImport.session.stopped")}
                    </p>
                )}
                {operation === "preview" && (
                    <p role="status" className="text-sm text-muted-foreground">
                        {t("portfolioImport.session.previewing")}
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {review && (
                    <section
                        aria-label={t("portfolioImport.session.review")}
                        className="space-y-4 rounded-lg border p-4"
                    >
                        <h3 className="font-medium">
                            {t("portfolioImport.session.review")}
                        </h3>
                        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                            {actions
                                .filter(
                                    (action) => review.plan.summary[action] > 0,
                                )
                                .map((action) => (
                                    <div key={action}>
                                        <dt className="text-muted-foreground">
                                            {t(
                                                `portfolioImport.session.actions.${action}`,
                                            )}
                                        </dt>
                                        <dd className="text-lg font-semibold">
                                            {review.plan.summary[action]}
                                        </dd>
                                    </div>
                                ))}
                        </dl>
                        {review.plan.blockers.length > 0 && (
                            <div
                                role="alert"
                                className="space-y-2 text-sm text-destructive"
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
                        <details>
                            <summary className="cursor-pointer text-sm font-medium">
                                {t("portfolioImport.session.evidence")}
                            </summary>
                            <div className="mt-3 space-y-3">
                                {review.plan.actions
                                    .slice(0, shownActions)
                                    .map((action) => (
                                        <article
                                            key={`${action.batchId}-${action.rowId}`}
                                            className="rounded-md border p-3 text-sm"
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
                                                <p className="text-xs text-muted-foreground">
                                                    {t(
                                                        "portfolioImport.session.existingId",
                                                        {
                                                            id: action.existingTransactionId,
                                                        },
                                                    )}
                                                </p>
                                            )}
                                            {action.action ===
                                                "repair_duplicate" && (
                                                <p className="mt-1 text-xs text-muted-foreground">
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
                                                <p className="mt-1 text-xs text-muted-foreground">
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
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    {t(
                                                        "portfolioImport.session.annotationHint",
                                                    )}
                                                </p>
                                            )}
                                            {action.transfer && (
                                                <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
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
                                                <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
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
                                                    <table className="w-full text-left text-xs">
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
                                                                                    ? "bg-muted/60"
                                                                                    : undefined
                                                                            }
                                                                        >
                                                                            <th className="p-1 font-normal">
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
                        </details>
                        <p className="text-sm text-muted-foreground">
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
                    <p role="status" className="text-sm text-muted-foreground">
                        {t("portfolioImport.session.committing")}
                    </p>
                )}
                {result && (
                    <p role="status" className="text-sm">
                        {t("portfolioImport.session.success", {
                            imported: result.imported,
                            adopted: result.adopted,
                            repaired: result.repaired,
                            duplicates: Math.max(
                                0,
                                result.duplicates -
                                    result.adopted -
                                    result.repaired,
                            ),
                        })}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
