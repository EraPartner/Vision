import { useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { isShortcutSafeTarget } from "@/lib/keyboard";
import { GO_TO_ROUTES } from "@/lib/navigation";
import { isElectron } from "@/lib/api/electron";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function Key({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex min-w-[1.6rem] items-center justify-center rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {children}
        </kbd>
    );
}

interface ShortcutsOverlayProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/** `?` (or the palette's "Keyboard shortcuts" action) opens a glass sheet
 *  listing the app's real keyboard shortcuts. */
export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
    const { t } = useLanguage();

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !isShortcutSafeTarget(e.target)) {
                e.preventDefault();
                onOpenChange(!open);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [open, onOpenChange]);

    const mod = IS_MAC ? "⌘" : "Ctrl";
    const general: Array<{ keys: React.ReactNode; label: string }> = [
        { keys: <><Key>{mod}</Key> <Key>K</Key></>, label: t("commandPalette.openLabel") },
        { keys: <><Key>{mod}</Key> <Key>,</Key></>, label: t("layout.settings") },
        { keys: <><Key>{mod}</Key> <Key>B</Key></>, label: t("aria.toggleSidebar") },
        { keys: <><Key>[</Key> <Key>]</Key></>, label: t("shortcuts.cycleSections") },
        { keys: <><Key>{mod}</Key> <Key>Z</Key></>, label: t("shortcuts.undoDelete") },
        { keys: <><Key>↑</Key> <Key>↓</Key></>, label: t("shortcuts.tableNav") },
        { keys: <Key>↵</Key>, label: t("shortcuts.tableOpen") },
        { keys: <Key>Space</Key>, label: t("shortcuts.quickLook") },
        { keys: <Key>?</Key>, label: t("shortcuts.showHelp") },
        { keys: <Key>Esc</Key>, label: t("shortcuts.closeDialog") },
    ];

    // Native menu accelerators — desktop app only. Mirror packaging/electron/main.js's
    // application menu; ⇧/⌃ modifiers differ by platform (⇧⌘I/⌃⌘S on macOS, Ctrl+Shift on
    // Windows/Linux), matching the `process.platform === 'darwin'` branches there.
    const shift = IS_MAC ? "⇧" : "Shift";
    const ctrl = IS_MAC ? "⌃" : "Ctrl";
    const desktop: Array<{ keys: React.ReactNode; label: string }> = [
        { keys: <><Key>{mod}</Key> <Key>N</Key></>, label: t("shortcuts.newTransaction") },
        {
            keys: IS_MAC
                ? <><Key>{shift}</Key> <Key>{mod}</Key> <Key>I</Key></>
                : <><Key>{ctrl}</Key> <Key>{shift}</Key> <Key>I</Key></>,
            label: t("shortcuts.importCsv"),
        },
        {
            keys: IS_MAC
                ? <><Key>{ctrl}</Key> <Key>{mod}</Key> <Key>S</Key></>
                : <><Key>{ctrl}</Key> <Key>{shift}</Key> <Key>S</Key></>,
            label: t("aria.toggleSidebar"),
        },
        { keys: <><Key>{mod}</Key> <Key>1</Key>–<Key>9</Key></>, label: t("shortcuts.goToSection") },
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="font-display">{t("shortcuts.title")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    {general.map((row, i) => (
                        <div key={i} className="flex items-center justify-between gap-4 text-sm">
                            <span className="text-foreground/85">{row.label}</span>
                            <span className="flex items-center gap-1">{row.keys}</span>
                        </div>
                    ))}
                    <p className="pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
                        {t("shortcuts.goTo")}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {GO_TO_ROUTES.map((route) => (
                            <div key={route.key} className="flex items-center justify-between gap-3 text-sm">
                                <span className="truncate text-foreground/85">{t(route.titleKey)}</span>
                                <span className="flex shrink-0 items-center gap-1">
                                    <Key>G</Key>
                                    <Key>{route.key.toUpperCase()}</Key>
                                </span>
                            </div>
                        ))}
                    </div>
                    {isElectron() && (
                        <>
                            <p className="pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
                                {t("shortcuts.desktopSection")}
                            </p>
                            {desktop.map((row, i) => (
                                <div key={`desktop-${i}`} className="flex items-center justify-between gap-4 text-sm">
                                    <span className="text-foreground/85">{row.label}</span>
                                    <span className="flex items-center gap-1">{row.keys}</span>
                                </div>
                            ))}
                        </>
                    )}
                    <p className="pt-1 text-xs text-muted-foreground">{t("shortcuts.chartScrub")}</p>
                    <p className="text-xs text-muted-foreground">{t("shortcuts.rowMenu")}</p>
                </div>
            </DialogContent>
        </Dialog>
    );
}
