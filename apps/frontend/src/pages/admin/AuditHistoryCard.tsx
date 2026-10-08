import { useCallback, useEffect, useRef, useState } from "react";
import { FileClock } from "lucide-react";
import type {
    ElectronAuditEntry,
    ElectronAuditVerification,
} from "@vision/types/electron";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List } from "@/components/ui/list";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 100;
const EXPORT_ENTRY_LIMIT = 500;

interface AuditPage {
    verification: ElectronAuditVerification;
    entries: ElectronAuditEntry[];
    hasMore: boolean;
}

function entryLabel(entry: ElectronAuditEntry): string {
    const { stream, event } = entry.payload;
    return (
        [stream, event]
            .filter((value): value is string => typeof value === "string")
            .join(" · ") || `#${entry.sequence}`
    );
}

/** A result line under an action: polite for success, assertive for failure. */
function OutcomeNote({
    outcome,
    successKey,
    failedKey,
}: {
    outcome: "success" | "failed" | undefined;
    successKey: string;
    failedKey: string;
}) {
    const { t } = useLanguage();
    if (!outcome) return null;
    return (
        <p
            role={outcome === "failed" ? "alert" : "status"}
            className={cn(
                "type-footnote",
                outcome === "failed"
                    ? "text-destructive"
                    : "text-label-secondary",
            )}
        >
            {t(outcome === "success" ? successKey : failedKey)}
        </p>
    );
}

export function AuditHistoryCard() {
    const { t } = useLanguage();
    const [page, setPage] = useState<AuditPage>();
    const [status, setStatus] = useState<"unavailable" | "failed">();
    const [unavailableReason, setUnavailableReason] = useState<
        "no_trusted_anchor" | undefined
    >();
    const [busy, setBusy] = useState(false);
    const [exportBusy, setExportBusy] = useState(false);
    const [enrollBusy, setEnrollBusy] = useState(false);
    const [enrollFailed, setEnrollFailed] = useState(false);
    const [transferPassword, setTransferPassword] = useState("");
    const [transferBusy, setTransferBusy] = useState(false);
    const [transferMessage, setTransferMessage] = useState<
        "success" | "failed"
    >();
    const [rotationBusy, setRotationBusy] = useState(false);
    const [rotationMessage, setRotationMessage] = useState<
        "success" | "failed"
    >();
    const [exportMessage, setExportMessage] = useState<
        "success" | "failed" | undefined
    >();
    const [changed, setChanged] = useState(false);
    const requestId = useRef(0);

    const load = useCallback(async (previous?: AuditPage) => {
        const bridge = window.electronAudit;
        if (!bridge) {
            setStatus("unavailable");
            setUnavailableReason(undefined);
            setPage(undefined);
            return;
        }
        const id = ++requestId.current;
        setBusy(true);
        setExportMessage(undefined);
        try {
            const afterSequence = previous?.entries.at(-1)?.sequence ?? 0;
            const result = await bridge.read({
                afterSequence,
                limit: PAGE_SIZE,
            });
            if (id !== requestId.current) return;
            if (!result.success) {
                setPage(undefined);
                setStatus(result.status);
                setUnavailableReason(result.reason);
                return;
            }
            if (
                previous &&
                (result.verification.sequence !==
                    previous.verification.sequence ||
                    result.verification.hash !== previous.verification.hash ||
                    result.verification.anchoredThrough !==
                        previous.verification.anchoredThrough ||
                    result.verification.retentionThrough !==
                        previous.verification.retentionThrough ||
                    result.entries[0]?.sequence !== afterSequence + 1)
            ) {
                setPage(undefined);
                setChanged(true);
                return;
            }
            setPage({
                verification: result.verification,
                entries: previous
                    ? [...previous.entries, ...result.entries]
                    : result.entries,
                hasMore: result.hasMore,
            });
            setChanged(false);
            setStatus(undefined);
            setUnavailableReason(undefined);
        } catch {
            if (id !== requestId.current) return;
            setPage(undefined);
            setStatus("failed");
            setUnavailableReason(undefined);
        } finally {
            if (id === requestId.current) setBusy(false);
        }
    }, []);

    useEffect(() => {
        void load();
        return () => {
            requestId.current += 1;
        };
    }, [load]);

    async function exportSnapshot() {
        if (!page || !window.electronAudit || exportBusy) return;
        setExportBusy(true);
        setExportMessage(undefined);
        try {
            const result = await window.electronAudit.exportSnapshot();
            if (result.success) setExportMessage("success");
            else if (!result.cancelled) setExportMessage("failed");
        } catch {
            setExportMessage("failed");
        } finally {
            setExportBusy(false);
        }
    }

    async function enroll() {
        if (!window.electronAudit || enrollBusy) return;
        setEnrollBusy(true);
        setEnrollFailed(false);
        try {
            const result = await window.electronAudit.enroll();
            if (result.success) await load();
            else if (!result.cancelled) setEnrollFailed(true);
        } catch {
            setEnrollFailed(true);
        } finally {
            setEnrollBusy(false);
        }
    }

    async function transfer(kind: "exportTransfer" | "importTransfer") {
        if (
            !window.electronAudit ||
            transferBusy ||
            transferPassword.length < 16
        )
            return;
        setTransferBusy(true);
        setTransferMessage(undefined);
        try {
            const result = await window.electronAudit[kind](transferPassword);
            if (!result.cancelled)
                setTransferMessage(result.success ? "success" : "failed");
            if (result.success && kind === "importTransfer") await load();
        } catch {
            setTransferMessage("failed");
        } finally {
            setTransferPassword("");
            setTransferBusy(false);
        }
    }

    async function rotateKey() {
        if (!window.electronAudit || rotationBusy) return;
        setRotationBusy(true);
        setRotationMessage(undefined);
        try {
            const result = await window.electronAudit.rotateKey();
            if (!result.cancelled)
                setRotationMessage(result.success ? "success" : "failed");
            if (result.success) await load();
        } catch {
            setRotationMessage("failed");
        } finally {
            setRotationBusy(false);
        }
    }

    const verification = page?.verification;
    const pendingCount = verification
        ? verification.sequence - verification.anchoredThrough
        : 0;
    const legacy = verification?.legacyUnverified;
    const exportTooLarge =
        verification !== undefined &&
        verification.sequence - (verification.retentionThrough ?? 0) >
            EXPORT_ENTRY_LIMIT;

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-primary/12 text-primary">
                        <FileClock className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 space-y-1">
                        <CardTitle variant="sm">
                            {t("admin.audit.title")}
                        </CardTitle>
                        <CardDescription>
                            {t("admin.audit.description")}
                        </CardDescription>
                    </div>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void load()}
                >
                    {t("admin.audit.refresh")}
                </Button>
            </CardHeader>
            <CardContent className="space-y-4">
                {busy && !page && !status && (
                    <div role="status" className="space-y-2">
                        <span className="sr-only">
                            {t("admin.audit.loading")}
                        </span>
                        <Skeleton className="h-4 w-56" />
                        <Skeleton className="h-11 w-full rounded-card" />
                        <Skeleton className="h-11 w-full rounded-card" />
                    </div>
                )}
                {status && (
                    <p
                        role={status === "failed" ? "alert" : "status"}
                        className={cn(
                            "type-body",
                            status === "failed"
                                ? "text-destructive"
                                : "text-label-secondary",
                        )}
                    >
                        {t(
                            status === "unavailable" &&
                                unavailableReason === "no_trusted_anchor"
                                ? "admin.audit.noTrustedAnchor"
                                : `admin.audit.${status}`,
                        )}
                    </p>
                )}
                {status === "unavailable" &&
                    unavailableReason === "no_trusted_anchor" &&
                    window.electronAudit && (
                        <div className="space-y-2">
                            <p className="type-footnote text-label-secondary">
                                {t("admin.audit.enrollExplanation")}
                            </p>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy || enrollBusy}
                                onClick={() => void enroll()}
                            >
                                {t("admin.audit.enroll")}
                            </Button>
                            {enrollFailed && (
                                <p
                                    role="alert"
                                    className="type-body text-destructive"
                                >
                                    {t("admin.audit.enrollFailed")}
                                </p>
                            )}
                        </div>
                    )}
                {changed && (
                    <p role="alert" className="type-body text-warning">
                        {t("admin.audit.changed")}
                    </p>
                )}
                {verification && (
                    <>
                        <div className="space-y-1 type-body">
                            <p className="font-medium text-success">
                                {verification.status === "verified"
                                    ? t("admin.audit.verified", {
                                          sequence: verification.sequence,
                                      })
                                    : t("admin.audit.partial", {
                                          anchored:
                                              verification.anchoredThrough,
                                      })}
                            </p>
                            {pendingCount > 0 && (
                                <p className="text-warning">
                                    {t("admin.audit.pending", {
                                        count: pendingCount,
                                    })}
                                </p>
                            )}
                            {verification.enrollmentSequence !== undefined && (
                                <p className="text-label-secondary">
                                    {t("admin.audit.enrollmentCaveat", {
                                        sequence:
                                            verification.enrollmentSequence,
                                    })}
                                </p>
                            )}
                            {verification.retentionThrough !== undefined && (
                                <p className="text-label-secondary">
                                    {t("admin.audit.retentionCaveat", {
                                        sequence: verification.retentionThrough,
                                    })}
                                </p>
                            )}
                            {legacy && (
                                <p className="text-label-secondary">
                                    {t("admin.audit.legacy", {
                                        dbEditor: legacy.dbEditor ?? "0",
                                        split: legacy.split ?? "0",
                                        portfolioRetag:
                                            legacy.portfolioRetag ?? "0",
                                    })}
                                </p>
                            )}
                        </div>

                        {page.entries.length === 0 ? (
                            <p className="type-body text-label-secondary">
                                {t("admin.audit.empty")}
                            </p>
                        ) : (
                            <List>
                                {page.entries.map((entry) => {
                                    const baseline =
                                        verification.enrollmentSequence !==
                                            undefined &&
                                        entry.sequence <=
                                            verification.enrollmentSequence;
                                    const anchored =
                                        entry.anchorStatus === "anchored";
                                    return (
                                        <li
                                            key={entry.sequence}
                                            className="px-4 py-3 type-body"
                                        >
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <span className="font-medium text-foreground">
                                                    #{entry.sequence}{" "}
                                                    {entryLabel(entry)}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "type-footnote",
                                                        baseline
                                                            ? "text-label-secondary"
                                                            : anchored
                                                              ? "text-success"
                                                              : "text-warning",
                                                    )}
                                                >
                                                    {t(
                                                        baseline
                                                            ? "admin.audit.enrollmentBaseline"
                                                            : anchored
                                                              ? "admin.audit.anchor"
                                                              : "admin.audit.pendingAnchor",
                                                    )}
                                                </span>
                                            </div>
                                            <p className="type-footnote text-label-secondary">
                                                {entry.createdAt}
                                            </p>
                                            <details className="mt-2">
                                                <summary className="cursor-pointer rounded-chip type-footnote text-label-secondary hover:text-foreground focus-ring">
                                                    {t("admin.audit.details")}
                                                </summary>
                                                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-card corner-continuous bg-foreground/[0.04] p-3 font-mono type-footnote">
                                                    {JSON.stringify(
                                                        {
                                                            hash: entry.hash,
                                                            previousHash:
                                                                entry.previousHash,
                                                            payload:
                                                                entry.payload,
                                                        },
                                                        null,
                                                        2,
                                                    )}
                                                </pre>
                                            </details>
                                        </li>
                                    );
                                })}
                            </List>
                        )}

                        {page.hasMore && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void load(page)}
                            >
                                {t("admin.audit.loadMore")}
                            </Button>
                        )}
                        <Separator />
                        <div className="space-y-2">
                            <p className="type-footnote text-label-secondary">
                                {t("admin.audit.exportLimit")}
                            </p>
                            {exportTooLarge && (
                                <p className="type-footnote text-warning">
                                    {t("admin.audit.exportUnavailable")}
                                </p>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={exportBusy || busy || exportTooLarge}
                                onClick={() => void exportSnapshot()}
                            >
                                {t("admin.audit.export")}
                            </Button>
                            <OutcomeNote
                                outcome={exportMessage}
                                successKey="admin.audit.exportSuccess"
                                failedKey="admin.audit.exportFailed"
                            />
                        </div>
                    </>
                )}
                {window.electronAudit && (
                    <>
                        <Separator />
                        <div className="space-y-3">
                            <p className="type-footnote text-label-secondary">
                                {t("admin.audit.transferExplanation")}
                            </p>
                            <div className="space-y-1.5">
                                <Label htmlFor="audit-transfer-password">
                                    {t("admin.audit.transferPassword")}
                                </Label>
                                <Input
                                    id="audit-transfer-password"
                                    type="password"
                                    autoComplete="new-password"
                                    minLength={16}
                                    maxLength={1024}
                                    value={transferPassword}
                                    onChange={(event) =>
                                        setTransferPassword(event.target.value)
                                    }
                                    className="max-w-sm"
                                />
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={
                                        transferBusy ||
                                        transferPassword.length < 16 ||
                                        !page
                                    }
                                    onClick={() =>
                                        void transfer("exportTransfer")
                                    }
                                >
                                    {t("admin.audit.transferExport")}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={
                                        transferBusy ||
                                        transferPassword.length < 16
                                    }
                                    onClick={() =>
                                        void transfer("importTransfer")
                                    }
                                >
                                    {t("admin.audit.transferImport")}
                                </Button>
                            </div>
                            <OutcomeNote
                                outcome={transferMessage}
                                successKey="admin.audit.transferSuccess"
                                failedKey="admin.audit.transferFailed"
                            />
                        </div>
                        {page && (
                            <>
                                <Separator />
                                <div className="space-y-2">
                                    <p className="type-footnote text-label-secondary">
                                        {t("admin.audit.rotateExplanation")}
                                    </p>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={rotationBusy || busy}
                                        onClick={() => void rotateKey()}
                                    >
                                        {t("admin.audit.rotate")}
                                    </Button>
                                    <OutcomeNote
                                        outcome={rotationMessage}
                                        successKey="admin.audit.rotateSuccess"
                                        failedKey="admin.audit.rotateFailed"
                                    />
                                </div>
                            </>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
