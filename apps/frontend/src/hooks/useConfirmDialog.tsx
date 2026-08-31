import { useState, useCallback, useRef, type ReactNode } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmOptions {
    title?: string;
    description: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: "default" | "destructive";
}

export function useConfirmDialog() {
    const [open, setOpen] = useState(false);
    const [options, setOptions] = useState<ConfirmOptions>({ description: "" });
    const resolveRef = useRef<((value: boolean) => void) | null>(null);

    const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
        setOptions(opts);
        setOpen(true);
        return new Promise<boolean>((resolve) => {
            resolveRef.current = resolve;
        });
    }, []);

    const handleConfirm = useCallback(() => {
        setOpen(false);
        resolveRef.current?.(true);
        resolveRef.current = null;
    }, []);

    const handleCancel = useCallback(() => {
        setOpen(false);
        resolveRef.current?.(false);
        resolveRef.current = null;
    }, []);

    const { t } = useLanguage();

    // Keep the live render values in a ref so `ConfirmDialog` can have a stable
    // identity. Previously its deps included `open`/`options`, so every
    // open/close handed the consumer a new component type — React unmounted and
    // remounted the whole AlertDialog, killing its enter/exit animation.
    const renderRef = useRef({ open, options, handleConfirm, handleCancel, t });
    renderRef.current = { open, options, handleConfirm, handleCancel, t };

    const ConfirmDialog = useCallback(() => {
        const {
            open: isOpen,
            options: opts,
            handleConfirm: onConfirm,
            handleCancel: onCancel,
            t: translate,
        } = renderRef.current;
        return (
            <AlertDialog
                open={isOpen}
                onOpenChange={(v) => {
                    if (!v) onCancel();
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {opts.title ?? translate("common.confirm")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {opts.description}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={onCancel}>
                            {opts.cancelLabel ?? translate("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={onConfirm}
                            className={
                                opts.variant === "destructive"
                                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    : ""
                            }
                        >
                            {opts.confirmLabel ?? translate("common.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        );
    }, []);

    return { confirm, ConfirmDialog };
}
