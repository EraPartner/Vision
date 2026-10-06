import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import {
    SlidersHorizontal,
    Palette,
    BarChart3,
    Workflow,
    Bot,
    DatabaseBackup,
    Info,
    type LucideIcon,
} from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { List, ListRow } from "@/components/ui/list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GeneralSection } from "./sections/GeneralSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { StatisticsSection } from "./sections/StatisticsSection";
import { BehaviorSection } from "./sections/BehaviorSection";
import { AiSection } from "./sections/AiSection";
import { BackupSection } from "./sections/BackupSection";
import { AboutSection } from "./sections/AboutSection";

export type SettingsSectionId =
    | "general"
    | "appearance"
    | "statistics"
    | "behavior"
    | "ai"
    | "backup"
    | "about";

interface SectionDef {
    id: SettingsSectionId;
    labelKey: string;
    icon: LucideIcon;
}

const SECTIONS: SectionDef[] = [
    {
        id: "general",
        labelKey: "settings.tab.general",
        icon: SlidersHorizontal,
    },
    { id: "appearance", labelKey: "settings.tab.appearance", icon: Palette },
    {
        id: "statistics",
        labelKey: "settings.section.statistics",
        icon: BarChart3,
    },
    { id: "behavior", labelKey: "settings.section.behavior", icon: Workflow },
    { id: "ai", labelKey: "settings.section.ai", icon: Bot },
    { id: "backup", labelKey: "settings.tab.backup", icon: DatabaseBackup },
    { id: "about", labelKey: "settings.section.about", icon: Info },
];

export function resolveSettingsSection(
    tab: string | undefined,
): SettingsSectionId | undefined {
    if (SECTIONS.some((s) => s.id === tab)) return tab as SettingsSectionId;
    return undefined;
}

interface DashboardSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultTab?: string;
    onSectionChange?: (section: SettingsSectionId) => void;
}

/**
 * The Settings window (ADR-183): a macOS-style preferences window drawn as a
 * Dialog, because the desktop shell has exactly one BrowserWindow. A sidebar of
 * sections on the left, the current section's name in the title bar, and the
 * section's groups in a scrolling pane. Every control saves on change; the
 * window closes with its close button, Escape or the browser's Back.
 */
export function DashboardSettingsDialog({
    open,
    onOpenChange,
    defaultTab = "general",
    onSectionChange,
}: DashboardSettingsDialogProps) {
    const { t } = useLanguage();
    const tablistRef = useRef<HTMLUListElement>(null);
    const [activeSection, setActiveSection] = useState<SettingsSectionId>(
        () => resolveSettingsSection(defaultTab) ?? "general",
    );

    useEffect(() => {
        if (open)
            setActiveSection(resolveSettingsSection(defaultTab) ?? "general");
    }, [open, defaultTab]);

    const selectSection = (id: SettingsSectionId) => {
        setActiveSection(id);
        onSectionChange?.(id);
    };

    const handleSectionKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        index: number,
    ) => {
        let nextIndex: number | undefined;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            nextIndex = (index + 1) % SECTIONS.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            nextIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
        } else if (event.key === "Home") {
            nextIndex = 0;
        } else if (event.key === "End") {
            nextIndex = SECTIONS.length - 1;
        }

        if (nextIndex === undefined) return;
        event.preventDefault();
        const nextSection = SECTIONS[nextIndex];
        selectSection(nextSection.id);
        tablistRef.current
            ?.querySelector<HTMLButtonElement>(
                `#settings-tab-${nextSection.id}`,
            )
            ?.focus();
    };

    const renderSection = () => {
        switch (activeSection) {
            case "general":
                return <GeneralSection />;
            case "appearance":
                return <AppearanceSection />;
            case "statistics":
                return <StatisticsSection />;
            case "behavior":
                return <BehaviorSection />;
            case "ai":
                return <AiSection />;
            case "backup":
                return <BackupSection />;
            case "about":
                return <AboutSection onOpenChange={onOpenChange} />;
        }
    };

    const current = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                aria-describedby={undefined}
                className="flex h-[82vh] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 md:flex-row"
            >
                {/* The window is named "Settings" for assistive technology; the
                    visible title bar shows the current section instead, as a
                    macOS preferences window does. */}
                <DialogTitle className="sr-only">
                    {t("settings.title")}
                </DialogTitle>

                {/* Sidebar: a 224px rail from md up, a horizontally scrolling
                    row of sections below it (a fixed rail would leave ~120px
                    for every control at phone widths). */}
                <aside className="flex shrink-0 flex-col border-b border-border/60 bg-foreground/[0.025] md:w-56 md:border-b-0 md:border-r">
                    <List
                        ref={tablistRef}
                        role="tablist"
                        aria-label={t("settings.title")}
                        aria-orientation="vertical"
                        className="flex flex-row gap-1 divide-y-0 overflow-x-auto rounded-none border-0 bg-transparent p-2 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden md:flex-col md:gap-0.5 md:overflow-y-auto md:px-3 md:pt-10"
                    >
                        {SECTIONS.map(({ id, labelKey, icon: Icon }, index) => {
                            const active = activeSection === id;
                            return (
                                <ListRow
                                    key={id}
                                    asChild
                                    leading={<Icon aria-hidden="true" />}
                                    title={t(labelKey)}
                                    className="min-h-0 shrink-0"
                                >
                                    <button
                                        type="button"
                                        id={`settings-tab-${id}`}
                                        role="tab"
                                        aria-selected={active}
                                        aria-controls={`settings-panel-${id}`}
                                        tabIndex={active ? 0 : -1}
                                        onClick={() => selectSection(id)}
                                        onKeyDown={(event) =>
                                            handleSectionKeyDown(event, index)
                                        }
                                        className="rounded-control corner-continuous whitespace-nowrap aria-selected:bg-primary aria-selected:text-primary-foreground aria-selected:hover:bg-primary aria-selected:focus-visible:bg-primary aria-selected:[&_span]:text-primary-foreground"
                                    />
                                </ListRow>
                            );
                        })}
                    </List>
                    <p className="mt-auto hidden px-5 pb-4 type-caption text-label-tertiary md:block">
                        {t("settings.autosaveHint")}
                    </p>
                </aside>

                {/* Content: title bar with the section name, then the pane */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <header className="flex h-12 shrink-0 items-center border-b border-border/60 px-6 pr-14">
                        <h2
                            id="settings-section-heading"
                            className="type-title-3 truncate text-foreground"
                        >
                            {t(current.labelKey)}
                        </h2>
                    </header>
                    <ScrollArea
                        id={`settings-panel-${activeSection}`}
                        role="tabpanel"
                        aria-labelledby={`settings-tab-${activeSection}`}
                        tabIndex={0}
                        className="min-h-0 flex-1 focus-ring"
                    >
                        <div className="px-6 py-6">{renderSection()}</div>
                    </ScrollArea>
                </div>
            </DialogContent>
        </Dialog>
    );
}
