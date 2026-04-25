import { useState, useEffect, useCallback } from 'react';
import { useSettings, type ExclusionScope } from '@/contexts/SettingsContext';
import { useAppSettings, defaultAppSettings } from '@/contexts/AppSettingsContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
    Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import { toast } from 'sonner';
import { AppearanceTab } from './AppearanceTab';
import { GeneralTab } from './tabs/GeneralTab';
import { DashboardTab } from './tabs/DashboardTab';
import { AppTab } from './tabs/AppTab';
import { BackupTab } from './tabs/BackupTab';

interface DashboardSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultTab?: string;
}

export function DashboardSettingsDialog({ open, onOpenChange, defaultTab = 'general' }: DashboardSettingsDialogProps) {
    const { settings, updateSettings, resetSettings } = useSettings();
    const { appSettings, updateAppSettings, resetAppSettings } = useAppSettings();
    const { t } = useLanguage();

    const [activeTab, setActiveTab] = useState(defaultTab);
    useEffect(() => { setActiveTab(defaultTab); }, [defaultTab]);

    // Exclusion state (needed for save)
    const [localExcludedCategories, setLocalExcludedCategories] = useState<number[]>([]);
    const [localExcludedRecipients, setLocalExcludedRecipients] = useState<number[]>([]);
    const [localExcludeHidden, setLocalExcludeHidden] = useState(true);
    const [localExclusionScope, setLocalExclusionScope] = useState<ExclusionScope>('everywhere');

    // General settings (needed for save)
    const [localAppSettings, setLocalAppSettings] = useState(appSettings);

    // Backup dir/quit (needed for save — BackupTab initializes these via setters)
    const [backupDir, setBackupDir] = useState('');
    const [backupOnQuit, setBackupOnQuit] = useState(false);

    const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
        queryKey: ['categories', 'all'],
        queryFn: () => apiClient.getCategories({ limit: 1000 }),
        staleTime: 60000,
    });

    const { data: recipientsData, isLoading: recipientsLoading } = useQuery({
        queryKey: ['recipients', 'all'],
        queryFn: () => apiClient.getRecipients({ limit: 1000 }),
        staleTime: 60000,
    });

    const categories = categoriesData?.items ?? [];
    const recipients = recipientsData?.items ?? [];
    const isLoading = categoriesLoading || recipientsLoading;

    useEffect(() => {
        if (!open) return;
        setLocalExcludedCategories(settings.excludedCategoryIds);
        setLocalExcludedRecipients(settings.excludedRecipientIds);
        setLocalExcludeHidden(settings.excludeHiddenCategories);
        setLocalExclusionScope(settings.exclusionScope);
        setLocalAppSettings(appSettings);
        // BackupTab handles its own initialization via the open prop
    }, [open, settings, appSettings]);

    const handleAiModelChange = useCallback(
        (v: string) => setLocalAppSettings((prev) => ({ ...prev, aiDefaultModel: v })),
        [],
    );
    const handleAdminModeChange = useCallback(
        (enabled: boolean) => setLocalAppSettings((prev) => ({ ...prev, adminMode: enabled })),
        [],
    );

    const handleSave = () => {
        updateSettings({
            excludedCategoryIds: localExcludedCategories,
            excludedRecipientIds: localExcludedRecipients,
            excludeHiddenCategories: localExcludeHidden,
            exclusionScope: localExclusionScope,
        });
        updateAppSettings(localAppSettings);
        if (apiClient.isElectron()) {
            apiClient.saveBackupSettings({ backupDir, backupOnQuit });
        }
        onOpenChange(false);
        toast.success(t('settings.saved'));
    };

    const handleReset = () => {
        resetSettings();
        resetAppSettings();
        setLocalExcludedCategories([]);
        setLocalExcludedRecipients([]);
        setLocalExcludeHidden(true);
        setLocalExclusionScope('everywhere');
        setLocalAppSettings(defaultAppSettings);
        toast.info(t('settings.resetToDefaults'));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>{t('settings.title')}</DialogTitle>
                    <DialogDescription>
                        {t('settings.description')}
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
                    <TabsList className="grid w-full grid-cols-5">
                        <TabsTrigger value="general">{t('settings.tab.general')}</TabsTrigger>
                        <TabsTrigger value="appearance">{t('settings.tab.appearance')}</TabsTrigger>
                        <TabsTrigger value="dashboard">{t('settings.tab.dashboard')}</TabsTrigger>
                        <TabsTrigger value="app">{t('settings.tab.app')}</TabsTrigger>
                        <TabsTrigger value="backup">{t('settings.tab.backup')}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="general" className="flex-1 min-h-0">
                        <GeneralTab
                            localAppSettings={localAppSettings}
                            onUpdate={setLocalAppSettings}
                        />
                    </TabsContent>

                    <TabsContent value="appearance" className="flex-1 min-h-0">
                        <AppearanceTab />
                    </TabsContent>

                    <TabsContent value="dashboard" className="flex-1 min-h-0">
                        <DashboardTab
                            categories={categories}
                            recipients={recipients}
                            isLoading={isLoading}
                            excludedCategories={localExcludedCategories}
                            setExcludedCategories={setLocalExcludedCategories}
                            excludedRecipients={localExcludedRecipients}
                            setExcludedRecipients={setLocalExcludedRecipients}
                            excludeHidden={localExcludeHidden}
                            setExcludeHidden={setLocalExcludeHidden}
                            exclusionScope={localExclusionScope}
                            setExclusionScope={setLocalExclusionScope}
                        />
                    </TabsContent>

                    <TabsContent value="app" className="flex-1 min-h-0">
                        <AppTab
                            aiDefaultModel={localAppSettings.aiDefaultModel}
                            onAiModelChange={handleAiModelChange}
                            onReset={handleReset}
                            onOpenChange={onOpenChange}
                            dateFormat={localAppSettings.dateFormat}
                            adminMode={localAppSettings.adminMode ?? false}
                            onAdminModeChange={handleAdminModeChange}
                        />
                    </TabsContent>

                    <TabsContent value="backup" className="flex-1 min-h-0">
                        <BackupTab
                            open={open}
                            backupDir={backupDir}
                            setBackupDir={setBackupDir}
                            backupOnQuit={backupOnQuit}
                            setBackupOnQuit={setBackupOnQuit}
                        />
                    </TabsContent>
                </Tabs>

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t('settings.cancel')}
                    </Button>
                    <Button onClick={handleSave}>
                        {t('settings.save')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
