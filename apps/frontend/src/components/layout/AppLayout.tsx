import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { Button } from "@/components/ui/button";
import { Settings, Sun, Moon, Monitor, Clock, Search } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    DashboardSettingsDialog,
    resolveSettingsSection,
    type SettingsSectionId,
} from "@/features/settings/DashboardSettingsDialog";
import { useTheme } from "@/stores/hydration/ThemeHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { UpcomingPaymentsNotification } from "@/components/notifications/UpcomingPaymentsNotification";
import { FxStatusBanner } from "@/components/notifications/FxStatusBanner";
import { UpdateNotification } from "@/components/notifications/UpdateNotification";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { useOnboarding } from "@/features/onboarding/useOnboarding";
import { PageTransition } from "@/components/layout/PageTransition";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { PageTitleProvider, usePageTitle } from "@/contexts/PageTitleContext";
import { ShortcutsOverlay } from "@/components/shared/ShortcutsOverlay";
import { ShaderAurora } from "@/components/layout/ShaderAurora";
import { ElectronBridge } from "@/components/layout/ElectronBridge";
import { VisualEffectsController } from "@/components/layout/VisualEffectsController";
import {
    useGoToShortcuts,
    useSectionCycleShortcuts,
} from "@/hooks/useGoToShortcuts";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useVisualEffectsTier } from "@/hooks/useVisualEffectsTier";
import { consumeUndo } from "@/lib/undo";
import { isTypingTarget } from "@/lib/keyboard";
import { useWorkspace } from "@/hooks/useWorkspace";
import { cn } from "@/lib/utils";
import { BackgroundQueryIndicator } from "@/components/shared/BackgroundQueryIndicator";

interface AppLayoutProps {
    children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
    const location = useLocation();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const rawSettingsSection = searchParams.get("settings") ?? undefined;
    const settingsSection = resolveSettingsSection(rawSettingsSection);
    const settingsOpen = settingsSection !== undefined;
    const settingsEntryWasPushedRef = useRef(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);

    const writeSettingsSection = useCallback(
        (section: SettingsSectionId, replace: boolean) => {
            setSearchParams(
                (current) => {
                    const next = new URLSearchParams(current);
                    next.set("settings", section);
                    return next;
                },
                { replace },
            );
        },
        [setSearchParams],
    );
    const openSettingsOnTab = useCallback(
        (tab: string) => {
            if (!settingsOpen) settingsEntryWasPushedRef.current = true;
            writeSettingsSection(
                resolveSettingsSection(tab) ?? "general",
                settingsOpen,
            );
        },
        [settingsOpen, writeSettingsSection],
    );
    const closeSettings = useCallback(() => {
        if (settingsEntryWasPushedRef.current) {
            settingsEntryWasPushedRef.current = false;
            navigate(-1);
            return;
        }
        setSearchParams(
            (current) => {
                const next = new URLSearchParams(current);
                next.delete("settings");
                return next;
            },
            { replace: true },
        );
    }, [navigate, setSearchParams]);

    useEffect(() => {
        if (!settingsOpen) settingsEntryWasPushedRef.current = false;
    }, [settingsOpen]);

    useEffect(() => {
        if (!rawSettingsSection || rawSettingsSection === settingsSection)
            return;
        if (settingsSection) writeSettingsSection(settingsSection, true);
        else closeSettings();
    }, [
        rawSettingsSection,
        settingsSection,
        writeSettingsSection,
        closeSettings,
    ]);
    const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

    // ⌘, — the macOS settings convention (always free in Electron).
    // ⌘Z — consume a pending destructive-action undo (inert while typing,
    // so text-field undo keeps working).
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (
                e.key === "," &&
                (e.metaKey || e.ctrlKey) &&
                !e.altKey &&
                !e.shiftKey
            ) {
                e.preventDefault();
                openSettingsOnTab("general");
                return;
            }
            if (
                e.key.toLowerCase() === "z" &&
                (e.metaKey || e.ctrlKey) &&
                !e.altKey &&
                !e.shiftKey &&
                !isTypingTarget(e.target)
            ) {
                if (consumeUndo()) e.preventDefault();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [openSettingsOnTab]);
    const { mode, schedule, setMode, setSchedule } = useTheme();
    const { t } = useLanguage();
    const { workspace } = useWorkspace();
    const { tier: effectsTier, largeDisplay } = useVisualEffectsTier();
    useGoToShortcuts();
    useSectionCycleShortcuts();
    useDocumentTitle();

    // Launch navigation (the "open app on" startup-section setting) and the
    // "last opened page" restoration both live in StartupRedirect now, so there
    // is no competing window-state restore here.
    const {
        isComplete: onboardingComplete,
        isLoading: onboardingLoading,
        complete: completeOnboarding,
    } = useOnboarding();

    // Topbar material fades in once the page scrolls under it; the inline
    // page title appears once the large PageHeader has scrolled out.
    const [scrolled, setScrolled] = useState(false);
    const [titleVisible, setTitleVisible] = useState(false);
    useEffect(() => {
        const onScroll = () => {
            setScrolled(window.scrollY > 8);
            setTitleVisible(window.scrollY > 96);
        };
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    // On route change, move keyboard focus to the main content region. Without
    // this, focus is stranded on the just-clicked sidebar link and screen readers
    // get no page-change cue. <main> is tabIndex={-1} (programmatic-focus only,
    // no visible ring on mouse nav).
    const { pathname } = location;
    const isPrintReport =
        pathname === "/tax" ||
        pathname === "/statistics" ||
        pathname === "/portfolio/net-worth";
    const mainRef = useRef<HTMLElement>(null);
    useEffect(() => {
        mainRef.current?.focus();
    }, [pathname]);

    useEffect(() => {
        if (!isPrintReport) return;
        document.documentElement.dataset.printReport = "true";
        return () => {
            delete document.documentElement.dataset.printReport;
        };
    }, [isPrintReport]);

    const modeIcon = useMemo(
        () =>
            ({
                light: <Sun className="h-5 w-5" />,
                dark: <Moon className="h-5 w-5" />,
                system: <Monitor className="h-5 w-5" />,
                schedule: <Clock className="h-5 w-5" />,
            })[mode],
        [mode],
    );

    return (
        <PageTitleProvider>
            <SidebarProvider defaultOpen={false}>
                <ElectronBridge
                    onOpenSettings={openSettingsOnTab}
                    onOpenShortcuts={openShortcuts}
                />
                <VisualEffectsController />
                <div
                    className="relative min-h-screen flex w-full overflow-x-clip"
                    data-print-report={isPrintReport || undefined}
                >
                    {/* Skip link: first tab stop on every page. Visually hidden until
                    keyboard-focused (sr-only + focus:not-sr-only); when visible it
                    floats over the chrome using existing tokens only. focus:fixed
                    keeps it out of the flex flow so nothing shifts. */}
                    <a
                        href="#main"
                        onClick={(e) => {
                            e.preventDefault();
                            mainRef.current?.focus();
                        }}
                        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-xl focus:border focus:border-border/50 focus:bg-background/90 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-glass-soft focus:outline-none focus:ring-2 focus:ring-ring/70"
                    >
                        {t("layout.skipToContent")}
                    </a>
                    <div
                        aria-hidden="true"
                        className="liquid-canvas"
                        data-workspace={workspace}
                    >
                        {/* staticAtmosphere mirrors VisualEffectsController's
                        fx-static-atmosphere (largeDisplay && tier !== 'reduced'):
                        while ShaderAurora is mounted, tier is 'enhanced', so
                        largeDisplay alone is exactly that condition (ADR-075). */}
                        {effectsTier === "enhanced" && (
                            <ShaderAurora staticAtmosphere={largeDisplay} />
                        )}
                        <div className="liquid-canvas-grain" />
                    </div>
                    <AppSidebar />
                    <div className="flex-1 flex flex-col min-w-0">
                        <header
                            data-scrolled={scrolled}
                            className="app-topbar h-14 flex items-center px-4 sticky top-0 z-30"
                        >
                            <SidebarTrigger className="mr-4" />
                            <TopbarPageTitle visible={titleVisible} />
                            <div className="flex-1" />
                            <button
                                type="button"
                                onClick={() => setPaletteOpen(true)}
                                aria-label={t("commandPalette.openLabel")}
                                className="hidden sm:flex items-center gap-2 h-9 rounded-xl border border-border/50 bg-background/50 px-3 mr-2 text-sm text-muted-foreground tracking-tight transition-[border-color,background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-glide)] hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                            >
                                <Search className="h-3.5 w-3.5" />
                                <span className="hidden md:inline">
                                    {t("commandPalette.hint")}
                                </span>
                                <kbd className="hidden md:inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                                    ⌘K
                                </kbd>
                            </button>
                            <UpdateNotification />
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="premium-icon-action ml-auto mr-2"
                                        title={t("layout.toggleTheme")}
                                        aria-label={t("layout.toggleTheme")}
                                    >
                                        {modeIcon}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className="w-56"
                                >
                                    <DropdownMenuLabel>
                                        {t("layout.theme")}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        onClick={() => setMode("light")}
                                        className={
                                            mode === "light"
                                                ? "bg-accent/10"
                                                : ""
                                        }
                                    >
                                        <Sun className="h-4 w-4 mr-2" />
                                        {t("layout.light")}
                                        {mode === "light" && (
                                            <span className="ml-auto text-xs text-primary">
                                                ✓
                                            </span>
                                        )}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => setMode("dark")}
                                        className={
                                            mode === "dark"
                                                ? "bg-accent/10"
                                                : ""
                                        }
                                    >
                                        <Moon className="h-4 w-4 mr-2" />
                                        {t("layout.dark")}
                                        {mode === "dark" && (
                                            <span className="ml-auto text-xs text-primary">
                                                ✓
                                            </span>
                                        )}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => setMode("system")}
                                        className={
                                            mode === "system"
                                                ? "bg-accent/10"
                                                : ""
                                        }
                                    >
                                        <Monitor className="h-4 w-4 mr-2" />
                                        {t("layout.system")}
                                        {mode === "system" && (
                                            <span className="ml-auto text-xs text-primary">
                                                ✓
                                            </span>
                                        )}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => setMode("schedule")}
                                        className={
                                            mode === "schedule"
                                                ? "bg-accent/10"
                                                : ""
                                        }
                                    >
                                        <Clock className="h-4 w-4 mr-2" />
                                        {t("layout.schedule")}
                                        {mode === "schedule" && (
                                            <span className="ml-auto text-xs text-primary">
                                                ✓
                                            </span>
                                        )}
                                    </DropdownMenuItem>
                                    {mode === "schedule" && (
                                        <>
                                            <DropdownMenuSeparator />
                                            <div
                                                className="px-3 py-2 space-y-2"
                                                onClick={(e) =>
                                                    e.stopPropagation()
                                                }
                                            >
                                                <div className="flex items-center gap-2">
                                                    <Sun className="h-3.5 w-3.5 text-warning shrink-0" />
                                                    <Label
                                                        htmlFor="theme-light-from"
                                                        className="text-xs text-muted-foreground w-14 shrink-0"
                                                    >
                                                        {t("layout.lightAt")}
                                                    </Label>
                                                    <Input
                                                        id="theme-light-from"
                                                        type="time"
                                                        value={
                                                            schedule.lightFrom
                                                        }
                                                        onChange={(e) =>
                                                            setSchedule({
                                                                ...schedule,
                                                                lightFrom:
                                                                    e.target
                                                                        .value,
                                                            })
                                                        }
                                                        className="h-7 text-xs"
                                                    />
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Moon className="h-3.5 w-3.5 text-info shrink-0" />
                                                    <Label
                                                        htmlFor="theme-dark-from"
                                                        className="text-xs text-muted-foreground w-14 shrink-0"
                                                    >
                                                        {t("layout.darkAt")}
                                                    </Label>
                                                    <Input
                                                        id="theme-dark-from"
                                                        type="time"
                                                        value={
                                                            schedule.darkFrom
                                                        }
                                                        onChange={(e) =>
                                                            setSchedule({
                                                                ...schedule,
                                                                darkFrom:
                                                                    e.target
                                                                        .value,
                                                            })
                                                        }
                                                        className="h-7 text-xs"
                                                    />
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openSettingsOnTab("general")}
                                className="premium-icon-action ml-2"
                                title={`${t("layout.settings")} (⌘,)`}
                                aria-label={t("layout.openSettings")}
                            >
                                <Settings className="h-5 w-5" />
                            </Button>
                            <BackgroundQueryIndicator />
                        </header>
                        <main
                            id="main"
                            ref={mainRef}
                            tabIndex={-1}
                            className="flex-1 p-4 md:p-6 min-h-[calc(100vh-3.5rem)] outline-none focus:outline-none focus-visible:outline-none"
                        >
                            <div data-print-chrome>
                                <FxStatusBanner />
                                <UpcomingPaymentsNotification />
                            </div>
                            <PageTransition>{children}</PageTransition>
                        </main>
                    </div>
                </div>
                <CommandPalette
                    open={paletteOpen}
                    onOpenChange={setPaletteOpen}
                    onOpenSettings={openSettingsOnTab}
                    onOpenShortcuts={() => setShortcutsOpen(true)}
                />
                <ShortcutsOverlay
                    open={shortcutsOpen}
                    onOpenChange={setShortcutsOpen}
                />
                <DashboardSettingsDialog
                    open={settingsOpen}
                    onOpenChange={(open) => {
                        if (!open) closeSettings();
                    }}
                    defaultTab={settingsSection ?? "general"}
                    onSectionChange={(section) =>
                        writeSettingsSection(section, true)
                    }
                />
                {!onboardingLoading && (
                    <OnboardingWizard
                        open={!onboardingComplete}
                        onComplete={completeOnboarding}
                        onOpenSettings={openSettingsOnTab}
                    />
                )}
            </SidebarProvider>
        </PageTitleProvider>
    );
}

// iOS-style inline title: appears in the topbar once the large PageHeader
// scrolls out of view.
function TopbarPageTitle({ visible }: { visible: boolean }) {
    const { title } = usePageTitle();
    const shown = visible && Boolean(title);
    return (
        <div
            aria-hidden={!shown}
            className={cn(
                "min-w-0 truncate font-display text-sm font-semibold tracking-tight transition-[opacity,translate] duration-[var(--duration-normal)] ease-[var(--ease-glide)] motion-reduce:transition-none",
                shown
                    ? "opacity-100 translate-y-0"
                    : "pointer-events-none opacity-0 translate-y-1",
            )}
        >
            {title}
        </div>
    );
}
