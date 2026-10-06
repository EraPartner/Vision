import { toast } from "sonner";
import { clearUndo, registerUndo } from "@/lib/undo";

/**
 * "Forgive, don't warn" (ADR-179): a reversible action happens at once and
 * offers Undo in two places that share one slot — the toast's Undo button
 * and ⌘Z (`components/layout/AppLayout.tsx` consumes the registry). Taking
 * either path clears the other, so a restore can never run twice, and ⌘Z
 * dismisses the toast it fulfilled.
 */
export interface UndoToastOptions {
    message: string;
    /** Localized label of the Undo action, usually `t("common.undo")`. */
    undoLabel: string;
    undo: () => void | Promise<void>;
    description?: string;
    /** How long Undo stays available; the toast lives as long. */
    ttlMs?: number;
}

const DEFAULT_UNDO_TTL_MS = 8_000;

export function undoToast({
    message,
    undoLabel,
    undo,
    description,
    ttlMs = DEFAULT_UNDO_TTL_MS,
}: UndoToastOptions): string | number {
    const id = toast.success(message, {
        description,
        duration: ttlMs,
        action: {
            label: undoLabel,
            onClick: () => {
                clearUndo();
                void undo();
            },
        },
    });
    registerUndo(() => {
        toast.dismiss(id);
        return undo();
    }, ttlMs);
    return id;
}
