import { useState } from "react";
import { useSearchParams } from "react-router";
import { hasNativeShellCapability } from "@/lib/nativeShell";

/** Shared native report handoff; local web menu opens keep their existing dialog state. */
export function useReportDialogState() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [localExportOpen, setLocalExportOpen] = useState(false);
    const [nativeReports] = useState(() => hasNativeShellCapability("reports"));
    const nativeReportRequested = searchParams.get("export") === "pdf";
    const exportOpen = localExportOpen || nativeReportRequested;
    const setExportOpen = (open: boolean) => {
        if (nativeReports) {
            setSearchParams(
                (previous) => {
                    const next = new URLSearchParams(previous);
                    if (open) next.set("export", "pdf");
                    else next.delete("export");
                    return next;
                },
                { replace: true },
            );
            return;
        }
        setLocalExportOpen(open);
        if (!open && nativeReportRequested) {
            setSearchParams(
                (previous) => {
                    const next = new URLSearchParams(previous);
                    next.delete("export");
                    return next;
                },
                { replace: true },
            );
        }
    };
    return { exportOpen, setExportOpen, nativeReportRequested };
}
