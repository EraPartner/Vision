import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import {useTheme} from "@/contexts/ThemeContext";
import {toast, Toaster as Sonner, useSonner, type ToastT} from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({...props}: ToasterProps) => {
    const {mode = "system"} = useTheme();
    const disableBuiltInAnnouncements = useCallback((node: HTMLElement | null) => {
        node?.setAttribute("aria-live", "off");
    }, []);

    return (
        <>
            <ToastAnnouncements />
            <Sonner
                ref={disableBuiltInAnnouncements}
                theme={mode as ToasterProps["theme"]}
                className="toaster group"
                closeButton
                offset={18}
                hotkey={["altKey", "KeyT"]}
                toastOptions={{
                    classNames: {
                        toast:
                            "group toast glass-thick group-[.toaster]:rounded-xl group-[.toaster]:text-foreground group-[.toaster]:tracking-tight",
                        title: "group-[.toast]:font-display group-[.toast]:text-sm group-[.toast]:font-semibold",
                        description: "group-[.toast]:text-muted-foreground/90",
                        actionButton:
                            "group-[.toast]:rounded-md group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:shadow-[0_4px_14px_-6px_hsl(var(--primary)/0.4)]",
                        cancelButton:
                            "group-[.toast]:rounded-md group-[.toast]:bg-foreground/[0.06] group-[.toast]:text-muted-foreground",
                        success: "group-[.toaster]:text-success",
                        error: "group-[.toaster]:text-destructive",
                    },
                }}
                {...props}
            />
        </>
    );
};

function resolveToastNode(node: ToastT["title"] | ToastT["description"]): ReactNode {
    return typeof node === "function" ? node() : node;
}

function ToastAnnouncements() {
    const {toasts} = useSonner();
    const seen = useRef(new Map<ToastT["id"], ToastT>());
    const sequence = useRef(0);
    const [polite, setPolite] = useState<{key: number; items: ToastT[]} | null>(null);
    const [assertive, setAssertive] = useState<{key: number; items: ToastT[]} | null>(null);

    useEffect(() => {
        const currentIds = new Set(toasts.map((item) => item.id));
        seen.current.forEach((_item, id) => {
            if (!currentIds.has(id)) seen.current.delete(id);
        });

        const changed = [...toasts]
            .reverse()
            .filter((item) => seen.current.get(item.id) !== item);
        changed.forEach((item) => seen.current.set(item.id, item));
        if (changed.length === 0) return;

        const errors = changed.filter((item) => item.type === "error");
        const informational = changed.filter((item) => item.type !== "error");
        if (informational.length > 0) setPolite({key: ++sequence.current, items: informational});
        if (errors.length > 0) setAssertive({key: ++sequence.current, items: errors});
    }, [toasts]);

    return (
        <>
            <div className="sr-only" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
                {polite?.items.map((item) => (
                    <span key={`${polite.key}-${item.id}`}>
                        {resolveToastNode(item.title)} {resolveToastNode(item.description)}
                    </span>
                ))}
            </div>
            <div className="sr-only" aria-live="assertive" aria-atomic="false" aria-relevant="additions text">
                {assertive?.items.map((item) => (
                    <span key={`${assertive.key}-${item.id}`}>
                        {resolveToastNode(item.title)} {resolveToastNode(item.description)}
                    </span>
                ))}
            </div>
        </>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export {Toaster, toast};
