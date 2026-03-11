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
import { ArrowUpCircle, Download, ExternalLink, Loader2 } from "lucide-react";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface UpdateStatus {
    up_to_date: boolean;
    current_version: string;
    latest_version: string | null;
    published_at?: string;
    release_notes?: string;
    html_url?: string;
}

type ApplyPhase = "idle" | "pulling" | "restarting" | "done";

export function UpdateNotification() {
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [phase, setPhase] = useState<ApplyPhase>("idle");
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const check = useCallback(async () => {
        try {
            const data = await apiClient.checkForUpdates();
            setStatus(data);
        } catch {
            // Silently ignore — don't disrupt the app if the update check fails
        }
    }, []);

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

    const handleInstall = async () => {
        setPhase("pulling");
        try {
            const result = await apiClient.triggerDockerUpdate();

            if (result === null) {
                // Running in a browser, not inside Electron — update is automatic on restart
                toast.info("Close and reopen the app to apply the update.");
                setPhase("idle");
                setDialogOpen(false);
                return;
            }

            if (!result.success) {
                toast.error("Update failed", { description: result.error });
                setPhase("idle");
                return;
            }

            if (!result.wasNew) {
                toast.success("Already on the latest version");
                setPhase("done");
                await check();
                setDialogOpen(false);
                return;
            }

            // New image pulled — container is restarting, migrations running via entrypoint.
            setPhase("restarting");

            const poll = async (attempts: number) => {
                try {
                    const updated = await apiClient.checkForUpdates();
                    setStatus(updated);
                    setPhase("done");
                    setDialogOpen(false);
                    toast.success("Update complete", {
                        description: `Now running ${updated.current_version}`,
                        duration: 6000,
                    });
                } catch {
                    if (attempts > 0) {
                        setTimeout(() => poll(attempts - 1), 2000);
                    } else {
                        setPhase("done");
                        setDialogOpen(false);
                        toast.info("App updated. Reload the page if anything looks off.");
                    }
                }
            };
            setTimeout(() => poll(20), 3000);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Update failed";
            toast.error(msg);
            setPhase("idle");
        }
    };

    // Nothing to show when up to date or status not yet known
    if (!status || status.up_to_date) return null;

    const isApplying = phase === "pulling" || phase === "restarting";

    return (
        <>
            {/* Compact badge in the header */}
            <Button
                variant="ghost"
                size="sm"
                onClick={() => { setPhase("idle"); setDialogOpen(true); }}
                className="gap-1.5 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 font-medium text-xs h-8 px-2.5"
                title={`Version ${status.latest_version} is available`}
            >
                <ArrowUpCircle className="h-4 w-4" />
                <span className="hidden sm:inline">Update available</span>
            </Button>

            {/* Update dialog */}
            <Dialog open={dialogOpen} onOpenChange={(open) => { if (!isApplying) setDialogOpen(open); }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <ArrowUpCircle className="h-5 w-5 text-amber-500" />
                            Update available
                        </DialogTitle>
                        <DialogDescription>
                            Version{" "}
                            <span className="font-semibold text-foreground">{status.latest_version}</span>{" "}
                            is available
                            {status.current_version ? ` (current: ${status.current_version})` : ""}.
                        </DialogDescription>
                    </DialogHeader>

                    {status.published_at && (
                        <p className="text-xs text-muted-foreground -mt-2">
                            Released {new Date(status.published_at).toLocaleDateString()}
                        </p>
                    )}

                    {status.release_notes && (
                        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                            <p className="text-xs text-muted-foreground mb-1">What's new</p>
                            <p className="text-foreground whitespace-pre-line line-clamp-6">
                                {status.release_notes}
                            </p>
                        </div>
                    )}

                    {/* Phase indicator */}
                    {isApplying && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {phase === "pulling"
                                ? "Pulling latest image…"
                                : "Restarting — applying database migrations…"}
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        {status.html_url && (
                            <Button
                                variant="ghost"
                                size="sm"
                                asChild
                                className="mr-auto"
                            >
                                <a href={status.html_url} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                                    Release notes
                                </a>
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            onClick={() => setDialogOpen(false)}
                            disabled={isApplying}
                        >
                            Later
                        </Button>
                        <Button onClick={handleInstall} disabled={isApplying} className="gap-2">
                            {isApplying ? (
                                <><Loader2 className="h-4 w-4 animate-spin" /> {phase === "restarting" ? "Restarting…" : "Pulling…"}</>
                            ) : (
                                <><Download className="h-4 w-4" /> Install update</>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
