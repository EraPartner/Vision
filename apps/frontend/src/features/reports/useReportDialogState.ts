import { useState } from "react";
import { useSearchParams } from "react-router";

/** Shared native report handoff; local web menu opens keep their existing dialog state. */
export function useReportDialogState() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [localExportOpen, setLocalExportOpen] = useState(false);
    const nativeReportRequested = searchParams.get("export") === "pdf";
    const exportOpen = localExportOpen || nativeReportRequested;
    const setExportOpen = (open: boolean) => {
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
    return { exportOpen, setExportOpen };
}
