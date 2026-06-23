import { useState, useEffect } from 'react';
import {
    SlidersHorizontal, Palette, BarChart3, Workflow, Bot, DatabaseBackup, Info,
    type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import {
    Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GeneralSection } from './sections/GeneralSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { StatisticsSection } from './sections/StatisticsSection';
import { BehaviorSection } from './sections/BehaviorSection';
import { AiSection } from './sections/AiSection';
import { BackupSection } from './sections/BackupSection';
import { AboutSection } from './sections/AboutSection';

type SectionId = 'general' | 'appearance' | 'statistics' | 'behavior' | 'ai' | 'backup' | 'about';

interface SectionDef {
    id: SectionId;
    labelKey: string;
    icon: LucideIcon;
}

const SECTIONS: SectionDef[] = [
    { id: 'general', labelKey: 'settings.tab.general', icon: SlidersHorizontal },
    { id: 'appearance', labelKey: 'settings.tab.appearance', icon: Palette },
    { id: 'statistics', labelKey: 'settings.section.statistics', icon: BarChart3 },
    { id: 'behavior', labelKey: 'settings.section.behavior', icon: Workflow },
    { id: 'ai', labelKey: 'settings.section.ai', icon: Bot },
    { id: 'backup', labelKey: 'settings.tab.backup', icon: DatabaseBackup },
    { id: 'about', labelKey: 'settings.section.about', icon: Info },
];

// Map the legacy deep-link tab keys (used by the Electron menu bridge and
// onboarding) onto the new section ids so existing callers keep working.
const LEGACY_TAB_MAP: Record<string, SectionId> = {
    general: 'general',
    appearance: 'appearance',
    dashboard: 'statistics',
    app: 'about',
    backup: 'backup',
};

function resolveSection(tab: string | undefined): SectionId {
    if (tab && tab in LEGACY_TAB_MAP) return LEGACY_TAB_MAP[tab];
    if (SECTIONS.some((s) => s.id === tab)) return tab as SectionId;
    return 'general';
}

interface DashboardSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultTab?: string;
}

export function DashboardSettingsDialog({ open, onOpenChange, defaultTab = 'general' }: DashboardSettingsDialogProps) {
    const { t } = useLanguage();
    const [activeSection, setActiveSection] = useState<SectionId>(() => resolveSection(defaultTab));

    useEffect(() => {
        if (open) setActiveSection(resolveSection(defaultTab));
    }, [open, defaultTab]);

    const renderSection = () => {
        switch (activeSection) {
            case 'general': return <GeneralSection />;
            case 'appearance': return <AppearanceSection />;
            case 'statistics': return <StatisticsSection />;
            case 'behavior': return <BehaviorSection />;
            case 'ai': return <AiSection />;
            case 'backup': return <BackupSection />;
            case 'about': return <AboutSection onOpenChange={onOpenChange} />;
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[82vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="border-b border-border/60 px-6 py-4 text-left">
                    <DialogTitle>{t('settings.title')}</DialogTitle>
                    <DialogDescription>{t('settings.description')}</DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1">
                    {/* Sidebar nav */}
                    <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 p-2">
                        {SECTIONS.map(({ id, labelKey, icon: Icon }) => {
                            const active = activeSection === id;
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => setActiveSection(id)}
                                    aria-current={active ? 'page' : undefined}
                                    className={cn(
                                        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
                                        active
                                            ? 'bg-primary/10 text-primary'
                                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                                    )}
                                >
                                    <Icon className="h-4 w-4 shrink-0" />
                                    <span className="truncate">{t(labelKey)}</span>
                                </button>
                            );
                        })}
                    </nav>

                    {/* Content */}
                    <ScrollArea className="min-h-0 flex-1">
                        <div className="px-6 py-6">
                            {renderSection()}
                        </div>
                    </ScrollArea>
                </div>

                <div className="flex shrink-0 items-center justify-end border-t border-border/60 px-6 py-3.5">
                    <Button onClick={() => onOpenChange(false)}>{t('settings.done')}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
