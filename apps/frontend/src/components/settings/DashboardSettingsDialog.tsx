import { useState, useEffect, useCallback } from 'react';
import { useSettings, type ExclusionScope } from '@/contexts/SettingsContext';
import { useAppSettings, defaultAppSettings } from '@/contexts/AppSettingsContext';
import { useSettingsStore, type VisualEffectsTier } from '@/stores/settingsStore';
import { currentDisplayIsLarge } from '@/lib/visualEffects';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
    const queryClient = useQueryClient();

    const [activeTab, setActiveTab] = useState(defaultTab);
    useEffect(() => { setActiveTab(defaultTab); }, [defaultTab]);

    // Exclusion state (needed for save)
    const [localExcludedCategories, setLocalExcludedCategories] = useState<number[]>([]);
    const [localExcludedRecipients, setLocalExcludedRecipients] = useState<number[]>([]);
    const [localExcludeHidden, setLocalExcludeHidden] = useState(true);
    const [localExclusionScope, setLocalExclusionScope] = useState<ExclusionScope>('everywhere');
    // Internal-transfer exclusion (ADR-083) — standalone global setting.
    const [localIncludeTransfers, setLocalIncludeTransfers] = useState(false);

    // General settings (needed for save)
    const [localAppSettings, setLocalAppSettings] = useState(appSettings);

    // Visual-effects tier pick (ADR-075 addendum). null = untouched this
    // dialog session. The Appearance tab shows the tier currently in use;
    // a changed pick routes on Save to either the synced preference or —
    // while the auto-adapt cap is active — a session-only local override.
    const [tierSelection, setTierSelection] = useState<VisualEffectsTier | null>(null);
    const setSessionTierOverride = useSettingsStore((s) => s.setSessionTierOverride);

    // Backup dir/quit (needed for save). Loaded here — not in BackupTab — so the
    // values are initialized even when the Backup tab is never opened; saving
    // from another tab used to clobber the stored config with ''/false.
    const [backupDir, setBackupDir] = useState('');
    const [backupOnQuit, setBackupOnQuit] = useState(false);
    // Guard: only persist backup settings when state holds real loaded values
    // (or the user explicitly changed them) — never the untouched defaults.
    const [backupSettingsTrusted, setBackupSettingsTrusted] = useState(false);
    const [backupSettingsLoading, setBackupSettingsLoading] = useState(false);

    const updateBackupDir = useCallback((dir: string) => {
        setBackupDir(dir);
        setBackupSettingsTrusted(true);
    }, []);
    const updateBackupOnQuit = useCallback((v: boolean) => {
        setBackupOnQuit(v);
        setBackupSettingsTrusted(true);
    }, []);

    useEffect(() => {
        if (!open) {
            setBackupSettingsTrusted(false);
            return;
        }
        if (!apiClient.isElectron()) return;
        let cancelled = false;
        setBackupSettingsLoading(true);
        apiClient.loadBackupSettings()
            .then((bs) => {
                if (cancelled || !bs) return;
                setBackupDir(bs.backupDir || '');
                setBackupOnQuit(bs.backupOnQuit ?? false);
                setBackupSettingsTrusted(true);
            })
            .catch(() => { /* leave untrusted — save will skip backup settings */ })
            .finally(() => {
                if (!cancelled) setBackupSettingsLoading(false);
            });
        return () => { cancelled = true; };
    }, [open]);

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

    const { data: includeTransfersSetting } = useQuery({
        queryKey: ['setting', 'includeTransfers'],
        queryFn: () => apiClient.getSetting('includeTransfers'),
        staleTime: 60000,
        enabled: open,
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
        setTierSelection(null);
        // Backup settings are loaded by the dedicated [open] effect above.
    }, [open, settings, appSettings]);

    // Seed the include-transfers toggle from its freshly-queried value (separate
    // effect so a late query resolve doesn't reset the other locals).
    useEffect(() => {
        if (open) setLocalIncludeTransfers(includeTransfersSetting?.value === true);
    }, [open, includeTransfersSetting]);

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
        const next = { ...localAppSettings };
        const stagedAuto = next.autoAdaptDisplay ?? true;
        const savedAuto = appSettings.autoAdaptDisplay ?? true;
        if (tierSelection !== null) {
            if (stagedAuto && currentDisplayIsLarge()) {
                // Capped display: the pick is a session-only, this-device-only
                // override of the cap; the synced preference stays untouched.
                // Picking 'reduced' (= what the cap gives) clears the override.
                setSessionTierOverride(tierSelection === 'reduced' ? undefined : tierSelection);
            } else {
                next.visualEffects = tierSelection;
                setSessionTierOverride(undefined);
            }
        } else if (stagedAuto !== savedAuto) {
            // Auto mode toggled without touching the tier — auto takes back control.
            setSessionTierOverride(undefined);
        }
        updateAppSettings(next);
        // Persist the standalone include-transfers setting + refresh cash-flow data.
        apiClient.saveSetting('includeTransfers', localIncludeTransfers).catch(() => { /* non-fatal */ });
        queryClient.invalidateQueries();
        if (apiClient.isElectron() && backupSettingsTrusted) {
            apiClient.saveBackupSettings({ backupDir, backupOnQuit });
        }
        onOpenChange(false);
        toast.success(t('settings.saved'));
    };

    const handleReset = () => {
        resetSettings();
        resetAppSettings(); // also clears the session tier override
        setTierSelection(null);
        setLocalExcludedCategories([]);
        setLocalExcludedRecipients([]);
        setLocalExcludeHidden(true);
        setLocalExclusionScope('everywhere');
        setLocalIncludeTransfers(false);
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
                        <AppearanceTab
                            localAppSettings={localAppSettings}
                            onUpdate={setLocalAppSettings}
                            tierSelection={tierSelection}
                            onTierSelect={setTierSelection}
                        />
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
                            includeTransfers={localIncludeTransfers}
                            setIncludeTransfers={setLocalIncludeTransfers}
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
                            setBackupDir={updateBackupDir}
                            backupOnQuit={backupOnQuit}
                            setBackupOnQuit={updateBackupOnQuit}
                            settingsLoading={backupSettingsLoading}
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
