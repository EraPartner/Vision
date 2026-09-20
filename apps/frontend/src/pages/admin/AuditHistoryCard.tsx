import { useCallback, useEffect, useRef, useState } from "react";
import { FileClock } from "lucide-react";
import type {
    ElectronAuditEntry,
    ElectronAuditVerification,
} from "@vision/types/electron";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

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

    return (
        <Card className="glass-chrome">
            <CardContent variant="headerless" className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                            <FileClock className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold">
                                {t("admin.audit.title")}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                {t("admin.audit.description")}
                            </p>
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
                </div>

                {busy && !page && !status && (
                    <p role="status" className="text-sm text-muted-foreground">
                        {t("admin.audit.loading")}
                    </p>
                )}
                {status && (
                    <p
                        role={status === "failed" ? "alert" : "status"}
                        className={
                            status === "failed"
                                ? "text-sm text-destructive"
                                : "text-sm text-muted-foreground"
                        }
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
                            <p className="text-xs text-muted-foreground">
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
                                    className="text-sm text-destructive"
                                >
                                    {t("admin.audit.enrollFailed")}
                                </p>
                            )}
                        </div>
                    )}
                {changed && (
                    <p role="alert" className="text-sm text-warning">
                        {t("admin.audit.changed")}
                    </p>
                )}
                {verification && (
                    <>
                        <div className="space-y-1 text-sm">
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
                                <p className="text-muted-foreground">
                                    {t("admin.audit.enrollmentCaveat", {
                                        sequence:
                                            verification.enrollmentSequence,
                                    })}
                                </p>
                            )}
                            {verification.retentionThrough !== undefined && (
                                <p className="text-muted-foreground">
                                    {t("admin.audit.retentionCaveat", {
                                        sequence: verification.retentionThrough,
                                    })}
                                </p>
                            )}
                            {legacy && (
                                <p className="text-muted-foreground">
                                    {t("admin.audit.legacy", {
                                        dbEditor: legacy.dbEditor ?? "0",
                                        split: legacy.split ?? "0",
                                        portfolioRetag:
                                            legacy.portfolioRetag ?? "0",
                                    })}
                                </p>
                            )}
                        </div>

                        <div className="space-y-2">
                            {page.entries.length === 0 && (
                                <p className="text-sm text-muted-foreground">
                                    {t("admin.audit.empty")}
                                </p>
                            )}
                            {page.entries.map((entry) => (
                                <div
                                    key={entry.sequence}
                                    className="rounded-lg border border-border/60 p-3 text-sm"
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="font-medium">
                                            #{entry.sequence}{" "}
                                            {entryLabel(entry)}
                                        </span>
                                        <span
                                            className={
                                                verification.enrollmentSequence !==
                                                    undefined &&
                                                entry.sequence <=
                                                    verification.enrollmentSequence
                                                    ? "text-muted-foreground"
                                                    : entry.anchorStatus ===
                                                        "anchored"
                                                      ? "text-success"
                                                      : "text-warning"
                                            }
                                        >
                                            {t(
                                                verification.enrollmentSequence !==
                                                    undefined &&
                                                    entry.sequence <=
                                                        verification.enrollmentSequence
                                                    ? "admin.audit.enrollmentBaseline"
                                                    : entry.anchorStatus ===
                                                        "anchored"
                                                      ? "admin.audit.anchor"
                                                      : "admin.audit.pendingAnchor",
                                            )}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {entry.createdAt}
                                    </p>
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-xs text-muted-foreground">
                                            {t("admin.audit.details")}
                                        </summary>
                                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                                            {JSON.stringify(
                                                {
                                                    hash: entry.hash,
                                                    previousHash:
                                                        entry.previousHash,
                                                    payload: entry.payload,
                                                },
                                                null,
                                                2,
                                            )}
                                        </pre>
                                    </details>
                                </div>
                            ))}
                        </div>

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
                        <div className="space-y-2 border-t border-border/60 pt-3">
                            <p className="text-xs text-muted-foreground">
                                {t("admin.audit.exportLimit")}
                            </p>
                            {verification.sequence -
                                (verification.retentionThrough ?? 0) >
                                EXPORT_ENTRY_LIMIT && (
                                <p className="text-xs text-warning">
                                    {t("admin.audit.exportUnavailable")}
                                </p>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                    exportBusy ||
                                    busy ||
                                    verification.sequence -
                                        (verification.retentionThrough ?? 0) >
                                        EXPORT_ENTRY_LIMIT
                                }
                                onClick={() => void exportSnapshot()}
                            >
                                {t("admin.audit.export")}
                            </Button>
                            {exportMessage && (
                                <p
                                    role={
                                        exportMessage === "failed"
                                            ? "alert"
                                            : "status"
                                    }
                                    className="text-xs text-muted-foreground"
                                >
                                    {t(
                                        `admin.audit.export${exportMessage === "success" ? "Success" : "Failed"}`,
                                    )}
                                </p>
                            )}
                        </div>
                    </>
                )}
                {window.electronAudit && (
                    <div className="space-y-2 border-t border-border/60 pt-3">
                        <p className="text-xs text-muted-foreground">
                            {t("admin.audit.transferExplanation")}
                        </p>
                        <label
                            htmlFor="audit-transfer-password"
                            className="block text-xs font-medium"
                        >
                            {t("admin.audit.transferPassword")}
                        </label>
                        <input
                            id="audit-transfer-password"
                            type="password"
                            autoComplete="new-password"
                            minLength={16}
                            maxLength={1024}
                            value={transferPassword}
                            onChange={(event) =>
                                setTransferPassword(event.target.value)
                            }
                            className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
                        />
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                    transferBusy ||
                                    transferPassword.length < 16 ||
                                    !page
                                }
                                onClick={() => void transfer("exportTransfer")}
                            >
                                {t("admin.audit.transferExport")}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                    transferBusy || transferPassword.length < 16
                                }
                                onClick={() => void transfer("importTransfer")}
                            >
                                {t("admin.audit.transferImport")}
                            </Button>
                        </div>
                        {transferMessage && (
                            <p
                                role={
                                    transferMessage === "failed"
                                        ? "alert"
                                        : "status"
                                }
                                className="text-xs text-muted-foreground"
                            >
                                {t(
                                    transferMessage === "success"
                                        ? "admin.audit.transferSuccess"
                                        : "admin.audit.transferFailed",
                                )}
                            </p>
                        )}
                        {page && (
                            <div className="space-y-2 border-t border-border/60 pt-3">
                                <p className="text-xs text-muted-foreground">
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
                                {rotationMessage && (
                                    <p
                                        role={
                                            rotationMessage === "failed"
                                                ? "alert"
                                                : "status"
                                        }
                                        className="text-xs text-muted-foreground"
                                    >
                                        {t(
                                            rotationMessage === "success"
                                                ? "admin.audit.rotateSuccess"
                                                : "admin.audit.rotateFailed",
                                        )}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
