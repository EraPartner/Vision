import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowUpCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

interface UpdateStatus {
    up_to_date: boolean;
    behind_by: number | string;
    latest_message?: string;
    latest_commit: string | null;
    current_commit: string;
}

export function UpdateNotification() {
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [applying, setApplying] = useState(false);
    const [applyResult, setApplyResult] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const check = useCallback(async () => {
        try {
            const data = await apiClient.checkForUpdates();
            setStatus(data);
        } catch {
            // Silently ignore — don't disrupt the app if update check fails
        }
    }, []);

    // Check on mount, then on a repeated interval (only when tab is visible)
    useEffect(() => {
        check();

        const schedule = () => {
            timerRef.current = setInterval(() => {
                if (!document.hidden) check();
            }, CHECK_INTERVAL_MS);
        };
        schedule();

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [check]);

    const handleApply = async () => {
        setApplying(true);
        setApplyResult(null);
        try {
            const result = await apiClient.applyUpdate();
            if (result.success) {
                setApplyResult(result.output || result.note);
                if (!result.already_up_to_date) {
                    // Re-check after successful pull so the badge disappears
                    await check();
                    toast.success("Update applied!", {
                        description: "Restart the server for changes to take effect.",
                        icon: <CheckCircle2 className="h-4 w-4" />,
                        duration: 8000,
                    });
                }
            } else {
                setApplyResult(`Failed: ${result.detail}`);
                toast.error("Update failed", { description: result.detail });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Update failed";
            setApplyResult(`Error: ${msg}`);
            toast.error(msg);
        } finally {
            setApplying(false);
        }
    };

    // Nothing to show when up to date or status not yet loaded
    if (!status || status.up_to_date) return null;

    const behind = typeof status.behind_by === "number" ? status.behind_by : "?";

    return (
        <>
            {/* Compact badge shown in the header */}
            <Button
                variant="ghost"
                size="sm"
                onClick={() => { setApplyResult(null); setDialogOpen(true); }}
                className="gap-1.5 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 font-medium text-xs h-8 px-2.5"
                title={`${behind} update${behind !== 1 ? "s" : ""} available`}
            >
                <ArrowUpCircle className="h-4 w-4" />
                <span className="hidden sm:inline">
                    {behind} update{behind !== 1 ? "s" : ""} available
                </span>
            </Button>

            {/* Update dialog */}
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <ArrowUpCircle className="h-5 w-5 text-amber-500" />
                            Update Available
                        </DialogTitle>
                        <DialogDescription>
                            Your installation is{" "}
                            <span className="font-semibold text-foreground">{behind}</span>{" "}
                            commit{behind !== 1 ? "s" : ""} behind the latest version.
                        </DialogDescription>
                    </DialogHeader>

                    {status.latest_message && (
                        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                            <p className="text-xs text-muted-foreground mb-1">Latest commit</p>
                            <p className="text-foreground font-medium">{status.latest_message}</p>
                            {status.latest_commit && (
                                <p className="text-xs text-muted-foreground font-mono mt-1">
                                    {status.latest_commit.slice(0, 7)}
                                </p>
                            )}
                        </div>
                    )}

                    <p className="text-sm text-muted-foreground">
                        Clicking <strong>Pull update</strong> runs{" "}
                        <code className="text-xs bg-muted px-1 py-0.5 rounded">git pull --ff-only</code>{" "}
                        on the server. Once complete, <strong>restart the server</strong> for
                        changes to take effect.
                    </p>

                    {applyResult && (
                        <pre className="text-xs bg-muted rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap break-words font-mono">
                            {applyResult}
                        </pre>
                    )}

                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={applying}>
                            Close
                        </Button>
                        <Button
                            onClick={handleApply}
                            disabled={applying}
                            className="gap-2"
                        >
                            {applying ? (
                                <><Loader2 className="h-4 w-4 animate-spin" /> Pulling…</>
                            ) : (
                                <><RefreshCw className="h-4 w-4" /> Pull update</>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
