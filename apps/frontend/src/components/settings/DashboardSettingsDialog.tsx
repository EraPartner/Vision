import { useState, useEffect } from 'react';
import { useSettings, type ExclusionScope } from '@/contexts/SettingsContext';
import { useAppSettings, defaultAppSettings } from '@/contexts/AppSettingsContext';
import { useOnboarding } from '@/components/onboarding/OnboardingWizard';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
    Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import { AlertCircle, Bot, CheckCircle2, Database, Download, ExternalLink, FolderOpen, Loader2, RefreshCw, RotateCcw, Sparkles, UploadCloud } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { formatDateStringWithAppSettings } from '@/components/shared/dateUtils';
import { useOllamaStatus, useOllamaModels } from '@/hooks/useOllamaStatus';
import { AppearanceTab } from './AppearanceTab';

interface DashboardSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultTab?: string;
}

const CURRENCIES = [
    'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK',
    'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'TRY', 'SAR', 'AED', 'INR',
    'BRL', 'MXN', 'ZAR', 'SGD', 'HKD', 'NZD', 'KRW', 'THB', 'MYR', 'PHP',
];

const DATE_FORMATS = [
    { value: 'DD/MM/YYYY', labelKey: 'settings.dateFormat.ddmmyyyy' },
    { value: 'MM/DD/YYYY', labelKey: 'settings.dateFormat.mmddyyyy' },
    { value: 'YYYY-MM-DD', labelKey: 'settings.dateFormat.yyyymmdd' },
    { value: 'DD.MM.YYYY', labelKey: 'settings.dateFormat.ddmmyyyy2' },
    { value: 'DD-MM-YYYY', labelKey: 'settings.dateFormat.ddmmyyyy3' },
];

const NUMBER_FORMATS = [
    { value: 'eu', labelKey: 'settings.numberFormat.eu' },
    { value: 'us', labelKey: 'settings.numberFormat.us' },
    { value: 'ch', labelKey: 'settings.numberFormat.ch' },
    { value: 'in', labelKey: 'settings.numberFormat.in' },
];

const DISMISSED_RECURRING_PATTERNS_KEY = 'dismissed_recurring_patterns';

export function DashboardSettingsDialog({ open, onOpenChange, defaultTab = 'general' }: DashboardSettingsDialogProps) {
    const { settings, updateSettings, resetSettings } = useSettings();
    const { appSettings, updateAppSettings, resetAppSettings } = useAppSettings();
    const { reset: resetOnboarding } = useOnboarding();
    const { t } = useLanguage();

    // Dashboard tab local state
    const [activeTab, setActiveTab] = useState(defaultTab);
    useEffect(() => { setActiveTab(defaultTab); }, [defaultTab]);

    const [localExcludedCategories, setLocalExcludedCategories] = useState<number[]>([]);
    const [localExcludedRecipients, setLocalExcludedRecipients] = useState<number[]>([]);
    const [localExcludeHidden, setLocalExcludeHidden] = useState(true);
    const [localExclusionScope, setLocalExclusionScope] = useState<ExclusionScope>('everywhere');
    const [recipientSearch, setRecipientSearch] = useState('');
    const [categorySearch, setCategorySearch] = useState('');

    // General tab local state
    const [localAppSettings, setLocalAppSettings] = useState(appSettings);

    // Backup tab state (Electron-only; stored in the database via backup_settings key)
    const [backupDir, setBackupDir] = useState('');
    const [backupOnQuit, setBackupOnQuit] = useState(false);
    const [backupLoading, setBackupLoading] = useState(false);
    const [backupRunning, setBackupRunning] = useState(false);
    const [encryptionStatus, setEncryptionStatus] = useState<{
        secureStorageAvailable: boolean;
        hasStoredPassphrase: boolean;
        hasEnvPassphrase: boolean;
    } | null>(null);
    const [backupPassphrase, setBackupPassphrase] = useState('');
    const [savingBackupPassphrase, setSavingBackupPassphrase] = useState(false);
    const [reminderDismissed, setReminderDismissed] = useState(false);

    // Restore state
    const [restoreFile, setRestoreFile] = useState('');
    const [restoreRunning, setRestoreRunning] = useState(false);
    const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);

    const handleSelectRestoreFile = async () => {
        const chosen = await apiClient.selectBackupFile();
        if (chosen) setRestoreFile(chosen);
    };

    const handleRestoreConfirmed = async () => {
        setRestoreConfirmOpen(false);
        if (!restoreFile) return;
        setRestoreRunning(true);
        try {
            const result = await apiClient.restoreBackup(restoreFile);
            if (!result) return;
            if (result.success) {
                toast.success(t('settings.restore.success'), {
                    description: t('settings.restore.successDesc').replace('{file}', result.file ?? restoreFile),
                    duration: 8000,
                });
                // The app container was restarted — reload the page after a short delay
                // so the frontend reconnects to the freshly restored backend.
                setTimeout(() => window.location.reload(), 3000);
            } else {
                toast.error(t('settings.restore.failed'), { description: result.error });
            }
        } catch (err: unknown) {
            toast.error(t('settings.restore.failed'), { description: String(err) });
        } finally {
            setRestoreRunning(false);
        }
    };

    // Update tab state
    type UpdateStatus = {
        up_to_date: boolean;
        current_version: string;
        latest_version: string | null;
        published_at?: string;
        release_notes?: string;
        html_url?: string;
        error?: string;
    } | null;
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(null);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    type ApplyPhase = 'idle' | 'pulling' | 'restarting' | 'done';
    const [applyPhase, setApplyPhase] = useState<ApplyPhase>('idle');
    const applyingUpdate = applyPhase !== 'idle' && applyPhase !== 'done';

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

    const categories = categoriesData?.items || [];
    const recipients = recipientsData?.items || [];

    useEffect(() => {
        if (open) {
            setLocalExcludedCategories(settings.excludedCategoryIds);
            setLocalExcludedRecipients(settings.excludedRecipientIds);
            setLocalExcludeHidden(settings.excludeHiddenCategories);
            setLocalExclusionScope(settings.exclusionScope);
            setLocalAppSettings(appSettings);
            setRecipientSearch('');
            setCategorySearch('');
            // Load backup settings from Electron settings.json
            if (apiClient.isElectron()) {
                setBackupLoading(true);
                Promise.all([
                    apiClient.loadBackupSettings(),
                    apiClient.getBackupEncryptionStatus(),
                ]).then(([bs, enc]) => {
                    if (bs) {
                        setBackupDir(bs.backupDir || '');
                        setBackupOnQuit(bs.backupOnQuit ?? false);
                    }
                    if (enc?.success) {
                        setEncryptionStatus({
                            secureStorageAvailable: enc.secureStorageAvailable,
                            hasStoredPassphrase: enc.hasStoredPassphrase,
                            hasEnvPassphrase: enc.hasEnvPassphrase,
                        });
                    }
                }).finally(() => setBackupLoading(false));
            }
            // load dismissal state for passphrase reminder (persist across sessions)
            try {
                const v = window.localStorage.getItem('vision.backup.passphrase.reminder.dismissed');
                setReminderDismissed(v === '1');
            } catch {
                // ignore
            }
        }
    }, [open, settings, appSettings]);

    const handleSave = () => {
        updateSettings({
            excludedCategoryIds: localExcludedCategories,
            excludedRecipientIds: localExcludedRecipients,
            excludeHiddenCategories: localExcludeHidden,
            exclusionScope: localExclusionScope,
        });
        updateAppSettings(localAppSettings);
        // Persist backup settings to Electron settings.json
        if (apiClient.isElectron()) {
            apiClient.saveBackupSettings({ backupDir, backupOnQuit });
        }
        onOpenChange(false);
        toast.success(t('settings.saved'));
    };

    const handleBrowseBackupDir = async () => {
        const chosen = await apiClient.selectBackupDir();
        if (chosen) setBackupDir(chosen);
    };

    const handleBackupNow = async () => {
        if (!backupDir) {
            toast.error(t('settings.backup.noDir'));
            return;
        }
        setBackupRunning(true);
        try {
            const result = await apiClient.runBackup(backupDir);
            if (!result) return;
            if (result.success) {
                toast.success(t('settings.backup.success'), {
                    description: t('settings.backup.successDesc').replace('{file}', result.file ?? ''),
                });
                if (result.warning) {
                    toast.info(result.warning);
                }
                if ((result.cleanupRemoved ?? 0) > 0) {
                    toast.info(t('settings.backup.cleanupRemoved').replace('{count}', String(result.cleanupRemoved ?? 0)));
                }
            } else {
                toast.error(t('settings.backup.failed'), { description: result.error });
            }
        } catch (err: unknown) {
            toast.error(t('settings.backup.failed'), { description: String(err) });
        } finally {
            setBackupRunning(false);
        }
    };

    const handleCheckForUpdates = async () => {
        setCheckingUpdate(true);
        try {
            const result = await apiClient.checkForUpdates();
            setUpdateStatus(result);
            if (result.up_to_date) {
                toast.success(t('settings.app.upToDate'));
            } else {
                toast.info(`${t('settings.app.updateAvailable')} ${result.latest_version}`);
            }
        } catch {
            toast.error(t('settings.app.updateFailed'));
        } finally {
            setCheckingUpdate(false);
        }
    };

    const handleSaveBackupPassphrase = async () => {
        setSavingBackupPassphrase(true);
            try {
                const result = await apiClient.setBackupPassphrase(backupPassphrase);
            if (!result) {
                toast.error(t('settings.backup.passphrase.unavailable'));
                return;
            }
            if (!result.success) {
                toast.error(t('settings.backup.passphrase.saveFailed'), { description: result.error });
                return;
            }

            const refreshed = await apiClient.getBackupEncryptionStatus();
            if (refreshed?.success) {
                setEncryptionStatus({
                    secureStorageAvailable: refreshed.secureStorageAvailable,
                    hasStoredPassphrase: refreshed.hasStoredPassphrase,
                    hasEnvPassphrase: refreshed.hasEnvPassphrase,
                });
            }

            const trimmed = backupPassphrase.trim();
            setBackupPassphrase('');
            toast.success(trimmed ? t('settings.backup.passphrase.saved') : t('settings.backup.passphrase.cleared'));
            // Remind the user to store the passphrase safely when they save one
            if (trimmed) {
                toast.info(t('settings.backup.passphrase.reminderTitle'), {
                    description: t('settings.backup.passphrase.reminderDesc'),
                    duration: 10000,
                });
                // show inline banner unless previously dismissed
                try {
                    window.localStorage.removeItem('vision.backup.passphrase.reminder.dismissed');
                    setReminderDismissed(false);
                } catch {}
            }
        } catch (err: unknown) {
            toast.error(t('settings.backup.passphrase.saveFailed'), { description: String(err) });
        } finally {
            setSavingBackupPassphrase(false);
        }
    };

    const handleClearBackupPassphrase = async () => {
        setSavingBackupPassphrase(true);
        try {
            const result = await apiClient.setBackupPassphrase('');
            if (!result?.success) {
                toast.error(t('settings.backup.passphrase.saveFailed'), { description: result?.error });
                return;
            }
            const refreshed = await apiClient.getBackupEncryptionStatus();
            if (refreshed?.success) {
                setEncryptionStatus({
                    secureStorageAvailable: refreshed.secureStorageAvailable,
                    hasStoredPassphrase: refreshed.hasStoredPassphrase,
                    hasEnvPassphrase: refreshed.hasEnvPassphrase,
                });
            }
            setBackupPassphrase('');
            toast.success(t('settings.backup.passphrase.cleared'));
        } catch (err: unknown) {
            toast.error(t('settings.backup.passphrase.saveFailed'), { description: String(err) });
        } finally {
            setSavingBackupPassphrase(false);
        }
    };

    const handleApplyUpdate = async () => {
        setApplyPhase('pulling');
        try {
            const result = await apiClient.installShellUpdate();
            if (result === null) {
                // Not running inside Electron — shouldn't happen since the button is
                // only shown in Electron, but guard anyway.
                toast.info(t('settings.app.updateAutoApply'));
                setApplyPhase('idle');
                return;
            }
            if (!result.success) {
                toast.error(t('settings.app.updateFailed'), { description: result.error });
                setApplyPhase('idle');
                return;
            }
            setApplyPhase('restarting');
            toast.success(t('settings.app.updateComplete'), {
                description: t('settings.app.nowRunning', { version: result.version ?? (updateStatus?.latest_version ?? '') }),
                duration: 8000,
            });
        } catch (err: unknown) {
            const msg = (err as { message?: string })?.message ?? t('settings.app.updateFailedDesc');
            toast.error(t('settings.app.updateFailed'), { description: msg });
            setApplyPhase('idle');
        }
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

    const handleResetRecurringDismissals = async () => {
        try {
            window.localStorage.removeItem(DISMISSED_RECURRING_PATTERNS_KEY);
        } catch {
            // ignore localStorage unavailability
        }

        try {
            await apiClient.saveSetting(DISMISSED_RECURRING_PATTERNS_KEY, []);
            toast.success(t('settings.app.recurringDismissalsResetSuccess'));
        } catch {
            toast.error(t('settings.app.recurringDismissalsResetFailed'));
        }
    };

    const handleRestartOnboarding = () => {
        resetOnboarding();
        onOpenChange(false);
        toast.success(t('settings.app.onboardingRestarted'));
        // Small delay then reload to trigger onboarding
        setTimeout(() => window.location.reload(), 500);
    };

    const toggleCategory = (categoryId: number) => {
        setLocalExcludedCategories((prev) =>
            prev.includes(categoryId)
                ? prev.filter((id) => id !== categoryId)
                : [...prev, categoryId]
        );
    };

    const toggleRecipient = (recipientId: number) => {
        setLocalExcludedRecipients((prev) =>
            prev.includes(recipientId)
                ? prev.filter((id) => id !== recipientId)
                : [...prev, recipientId]
        );
    };

    const isLoading = categoriesLoading || recipientsLoading;

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

                    {/* ── General Tab ── */}
                    <TabsContent value="general" className="flex-1 min-h-0">
                        <ScrollArea className="h-full pr-4">
                            <div className="space-y-6 py-4">
                                {/* Currency */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.currency')}</Label>
                                    <Select
                                        value={localAppSettings.defaultCurrency}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, defaultCurrency: v })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {CURRENCIES.map((c) => (
                                                <SelectItem key={c} value={c}>{c}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                        {t('settings.general.currencyHint')}
                                    </p>
                                </div>

                                <Separator />

                                {/* Date Format */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.dateFormat')}</Label>
                                    <Select
                                        value={localAppSettings.dateFormat}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, dateFormat: v })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {DATE_FORMATS.map((f) => (
                                                <SelectItem key={f.value} value={f.value}>{t(f.labelKey as any)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Number Format */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.numberFormat')}</Label>
                                    <Select
                                        value={localAppSettings.numberFormat}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, numberFormat: v })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {NUMBER_FORMATS.map((f) => (
                                                <SelectItem key={f.value} value={f.value}>{t(f.labelKey as any)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Decimal Places */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.decimalPlaces')}</Label>
                                    <Select
                                        value={String(localAppSettings.showDecimalPlaces)}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, showDecimalPlaces: Number(v) })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="0">0 (1,234)</SelectItem>
                                            <SelectItem value="1">1 (1,234.5)</SelectItem>
                                            <SelectItem value="2">2 (1,234.56)</SelectItem>
                                            <SelectItem value="3">3 (1,234.567)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Start of Week */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.startOfWeek')}</Label>
                                    <Select
                                        value={localAppSettings.startOfWeek}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, startOfWeek: v as 'monday' | 'sunday' })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="monday">{t('settings.general.monday')}</SelectItem>
                                            <SelectItem value="sunday">{t('settings.general.sunday')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Page Size */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.pageSize')}</Label>
                                    <Select
                                        value={String(localAppSettings.defaultPageSize)}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, defaultPageSize: Number(v) })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="25">25 {t('settings.general.rows')}</SelectItem>
                                            <SelectItem value="50">50 {t('settings.general.rows')}</SelectItem>
                                            <SelectItem value="100">100 {t('settings.general.rows')}</SelectItem>
                                            <SelectItem value="200">200 {t('settings.general.rows')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                        {t('settings.general.pageSizeHint')}
                                    </p>
                                </div>

                                <Separator />

                                {/* Language */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">{t('settings.general.language')}</Label>
                                    <Select
                                        value={localAppSettings.language ?? 'en'}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, language: v as 'en' | 'nl' })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="en">{t('settings.general.lang.en')}</SelectItem>
                                            <SelectItem value="nl">{t('settings.general.lang.nl')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                        {t('settings.general.languageHint')}
                                    </p>
                                </div>
                            </div>
                        </ScrollArea>
                    </TabsContent>

                    {/* ── Appearance Tab ── */}
                    <TabsContent value="appearance" className="flex-1 min-h-0">
                        <ScrollArea className="h-full pr-4">
                            <AppearanceTab />
                        </ScrollArea>
                    </TabsContent>

                    {/* ── Dashboard Tab ── */}
                    <TabsContent value="dashboard" className="flex-1 min-h-0">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            </div>
                        ) : (
                            <ScrollArea className="h-full pr-4">
                                <div className="space-y-6 py-4">
                                    {/* Exclusion Scope */}
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.exclusionScope')}</h3>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settings.dashboard.exclusionScopeHint')}
                                        </p>
                                        <Select
                                            value={localExclusionScope}
                                            onValueChange={(v) => setLocalExclusionScope(v as ExclusionScope)}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="everywhere">{t('settings.dashboard.scope.everywhere')}</SelectItem>
                                                <SelectItem value="dashboard">{t('settings.dashboard.scope.dashboard')}</SelectItem>
                                                <SelectItem value="statistics">{t('settings.dashboard.scope.statistics')}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <Separator />

                                    {/* General Settings */}
                                    <div className="space-y-4">
                                        <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.exclusionSettings')}</h3>
                                        <div className="flex items-center space-x-3 rounded-lg border p-4">
                                            <Checkbox
                                                id="exclude-hidden"
                                                checked={localExcludeHidden}
                                                onCheckedChange={(checked) => setLocalExcludeHidden(checked as boolean)}
                                            />
                                            <div className="flex-1">
                                                <Label
                                                    htmlFor="exclude-hidden"
                                                    className="text-sm font-medium cursor-pointer"
                                                >
                                                    {t('settings.dashboard.excludeHidden')}
                                                </Label>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    {t('settings.dashboard.excludeHiddenHint')}
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <Separator />

                                    {/* Categories Section */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.excludedCategories')}</h3>
                                            <Badge variant="secondary" className="text-xs">
                                                {localExcludedCategories.length} {t('settings.dashboard.excluded')}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settings.dashboard.excludedCategoriesHint')}
                                        </p>
                                        <Input
                                            placeholder={t('settings.dashboard.searchCategories')}
                                            value={categorySearch}
                                            onChange={(e) => setCategorySearch(e.target.value)}
                                            className="h-8 text-sm"
                                        />
                                        <ScrollArea className="h-[250px]">
                                            <div className="space-y-1">
                                                {categories.length === 0 ? (
                                                    <p className="text-sm text-muted-foreground text-center py-4">
                                                        {t('settings.dashboard.noCategories')}
                                                    </p>
                                                ) : (() => {
                                                    // Group by general, filter by search
                                                    const searchLower = categorySearch.toLowerCase();
                                                    const grouped = new Map<string, typeof categories>();
                                                    for (const cat of categories) {
                                                        const matchesSearch = !categorySearch ||
                                                            cat.general.toLowerCase().includes(searchLower) ||
                                                            cat.detail.toLowerCase().includes(searchLower);
                                                        if (!matchesSearch) continue;
                                                        const group = grouped.get(cat.general) || [];
                                                        group.push(cat);
                                                        grouped.set(cat.general, group);
                                                    }

                                                    if (grouped.size === 0) {
                                                        return (
                                                            <p className="text-sm text-muted-foreground text-center py-4">
                                                                {t('settings.dashboard.noMatchingCategories')}
                                                            </p>
                                                        );
                                                    }

                                                    return Array.from(grouped.entries())
                                                        .sort(([a], [b]) => a.localeCompare(b))
                                                        .map(([general, items]) => {
                                                            const allExcluded = items.every(c => localExcludedCategories.includes(c.id));
                                                            const someExcluded = items.some(c => localExcludedCategories.includes(c.id));

                                                            const toggleGroup = () => {
                                                                if (allExcluded) {
                                                                    // Remove all in group
                                                                    setLocalExcludedCategories(prev =>
                                                                        prev.filter(id => !items.some(c => c.id === id))
                                                                    );
                                                                } else {
                                                                    // Add all in group
                                                                    setLocalExcludedCategories(prev => {
                                                                        const newIds = items.map(c => c.id).filter(id => !prev.includes(id));
                                                                        return [...prev, ...newIds];
                                                                    });
                                                                }
                                                            };

                                                            return (
                                                                <div key={general} className="space-y-0.5">
                                                                    {/* Group header */}
                                                                    <div
                                                                        className="flex items-center space-x-3 rounded-md bg-muted/50 px-3 py-2 cursor-pointer hover:bg-muted transition-colors"
                                                                        onClick={toggleGroup}
                                                                    >
                                                                        <Checkbox
                                                                            checked={allExcluded ? true : someExcluded ? 'indeterminate' : false}
                                                                            onCheckedChange={toggleGroup}
                                                                        />
                                                                        <span className="text-sm font-semibold text-foreground flex-1">{general}</span>
                                                                        <span className="text-xs text-muted-foreground">{items.length}</span>
                                                                    </div>
                                                                    {/* Detail items */}
                                                                    {items
                                                                        .sort((a, b) => a.detail.localeCompare(b.detail))
                                                                        .map((category) => (
                                                                            <div
                                                                                key={category.id}
                                                                                className="flex items-center space-x-3 rounded-md border px-3 py-2 ml-6 hover:bg-accent/50 transition-colors"
                                                                            >
                                                                                <Checkbox
                                                                                    id={`category-${category.id}`}
                                                                                    checked={localExcludedCategories.includes(category.id)}
                                                                                    onCheckedChange={() => toggleCategory(category.id)}
                                                                                />
                                                                                <Label
                                                                                    htmlFor={`category-${category.id}`}
                                                                                    className="flex-1 text-sm cursor-pointer flex items-center justify-between"
                                                                                >
                                                                                    <span>{category.detail}</span>
                                                                                    {!category.active && (
                                                                                        <Badge variant="outline" className="ml-2 text-xs">
                                                                                            {t('settings.dashboard.hidden')}
                                                                                        </Badge>
                                                                                    )}
                                                                                </Label>
                                                                            </div>
                                                                        ))}
                                                                </div>
                                                            );
                                                        });
                                                })()}
                                            </div>
                                        </ScrollArea>
                                    </div>

                                    <Separator />

                                    {/* Recipients Section */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.excludedRecipients')}</h3>
                                            <Badge variant="secondary" className="text-xs">
                                                {localExcludedRecipients.length} {t('settings.dashboard.excluded')}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settings.dashboard.excludedRecipientsHint')}
                                        </p>
                                        <Input
                                            placeholder={t('settings.dashboard.searchRecipients')}
                                            value={recipientSearch}
                                            onChange={(e) => setRecipientSearch(e.target.value)}
                                            className="h-8 text-sm"
                                        />
                                        <ScrollArea className="h-[200px]">
                                            <div className="space-y-2">
                                                {(() => {
                                                    const filtered = recipients.filter(r =>
                                                        r.name.toLowerCase().includes(recipientSearch.toLowerCase())
                                                    );
                                                    if (filtered.length === 0) {
                                                        return (
                                                            <p className="text-sm text-muted-foreground text-center py-4">
                                                                {recipientSearch ? t('settings.dashboard.noMatchingRecipients') : t('settings.dashboard.noRecipients')}
                                                            </p>
                                                        );
                                                    }
                                                    // Show excluded first, then alphabetical
                                                    const sorted = [...filtered].sort((a, b) => {
                                                        const aExcl = localExcludedRecipients.includes(a.id) ? 0 : 1;
                                                        const bExcl = localExcludedRecipients.includes(b.id) ? 0 : 1;
                                                        if (aExcl !== bExcl) return aExcl - bExcl;
                                                        return a.name.localeCompare(b.name);
                                                    });
                                                    return sorted.map((recipient) => (
                                                        <div
                                                            key={recipient.id}
                                                            className="flex items-center space-x-3 rounded-md border px-3 py-2.5 hover:bg-accent/50 transition-colors"
                                                        >
                                                            <Checkbox
                                                                id={`recipient-${recipient.id}`}
                                                                checked={localExcludedRecipients.includes(recipient.id)}
                                                                onCheckedChange={() => toggleRecipient(recipient.id)}
                                                            />
                                                            <Label
                                                                htmlFor={`recipient-${recipient.id}`}
                                                                className="flex-1 text-sm cursor-pointer flex items-center justify-between"
                                                            >
                                                                <span>{recipient.name}</span>
                                                                {!recipient.active && (
                                                                    <Badge variant="outline" className="ml-2 text-xs">
                                                                        {t('settings.dashboard.hidden')}
                                                                    </Badge>
                                                                )}
                                                            </Label>
                                                        </div>
                                                    ));
                                                })()}
                                            </div>
                                        </ScrollArea>
                                    </div>
                                </div>
                            </ScrollArea>
                        )}
                    </TabsContent>

                    {/* ── App Tab ── */}
                    <TabsContent value="app" className="flex-1 min-h-0">
                        <ScrollArea className="h-full pr-4">
                            <div className="space-y-6 py-4">
                                {/* Restart Onboarding */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">{t('settings.app.setupWizard')}</h3>
                                    <div className="flex items-center justify-between rounded-lg border p-4">
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-foreground flex items-center gap-2">
                                                <Sparkles className="h-4 w-4 text-primary" />
                                                {t('settings.app.onboardingWizard')}
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {t('settings.app.onboardingWizardHint')}
                                            </p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleRestartOnboarding}
                                            className="ml-4 shrink-0"
                                        >
                                            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                            {t('settings.app.restart')}
                                        </Button>
                                    </div>
                                </div>

                                <Separator />

                                {/* App Updates */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">{t('settings.app.updates')}</h3>
                                    <p className="text-xs text-muted-foreground">
                                        {apiClient.isElectron()
                                            ? t('settings.app.updatesHintElectron')
                                            : t('settings.app.updatesHintWeb')}
                                    </p>

                                    {/* Status banner */}
                                    {updateStatus && (
                                        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                                            updateStatus.up_to_date
                                                ? 'border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400'
                                                : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400'
                                        }`}>
                                            {updateStatus.up_to_date
                                                ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                                                : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                            }
                                            <div className="flex-1 min-w-0">
                                                {updateStatus.up_to_date ? (
                                                    <p>{t('settings.app.runningLatest')}{updateStatus.current_version ? ` (${updateStatus.current_version})` : ''}.</p>
                                                ) : (
                                                    <>
                                                        <p className="font-medium">
                                                            {t('settings.app.versionAvailable', { version: updateStatus.latest_version ?? '' })}
                                                            {updateStatus.current_version ? ` (${t('settings.app.current')} ${updateStatus.current_version})` : ''}.
                                                        </p>
                                                        {updateStatus.published_at && (
                                                            <p className="text-xs mt-0.5 opacity-80">
                                                                {t('settings.app.released')} {formatDateStringWithAppSettings(updateStatus.published_at, appSettings.dateFormat)}
                                                            </p>
                                                        )}
                                                        {updateStatus.release_notes && (
                                                            <p className="text-xs mt-1 opacity-80 line-clamp-2">{updateStatus.release_notes}</p>
                                                        )}
                                                    </>
                                                )}
                                                {updateStatus.error && (
                                                    <p className="text-xs mt-0.5 opacity-80">{updateStatus.error}</p>
                                                )}
                                            </div>
                                            {updateStatus.html_url && (
                                                <a
                                                    href={updateStatus.html_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
                                                    title={t('update.releaseNotes')}
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                </a>
                                            )}
                                        </div>
                                    )}

                                    {/* Phase indicator while updating */}
                                    {(applyPhase === 'pulling' || applyPhase === 'restarting') && (
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            {applyPhase === 'pulling' ? t('settings.app.pulling') : t('settings.app.restarting')}
                                        </div>
                                    )}

                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleCheckForUpdates}
                                            disabled={checkingUpdate || applyingUpdate}
                                        >
                                            {checkingUpdate
                                                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                                            }
                                            {t('settings.app.checkForUpdates')}
                                        </Button>

                                        {/* Only shown inside Electron when an update is available */}
                                        {apiClient.isElectron() && updateStatus && !updateStatus.up_to_date && (
                                            <Button
                                                size="sm"
                                                onClick={handleApplyUpdate}
                                                disabled={applyingUpdate || checkingUpdate}
                                            >
                                                {applyingUpdate
                                                    ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                    : <Download className="h-3.5 w-3.5 mr-1.5" />
                                                }
                                                {applyPhase === 'restarting' ? t('settings.app.restarting2') : t('settings.app.installUpdate')}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <Separator />

                                {/* Reset recurring suggestion dismissals */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">{t('settings.app.recurringDismissals')}</h3>
                                    <div className="flex items-center justify-between rounded-lg border p-4">
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-foreground">{t('settings.app.recurringDismissalsReset')}</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {t('settings.app.recurringDismissalsResetHint')}
                                            </p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                void handleResetRecurringDismissals();
                                            }}
                                            className="ml-4 shrink-0"
                                        >
                                            {t('settings.app.reset')}
                                        </Button>
                                    </div>
                                </div>

                                <Separator />

                                {/* AI Chat */}
                                <AIChatSettingsSection
                                    value={localAppSettings.aiDefaultModel}
                                    onChange={(v) => setLocalAppSettings({ ...localAppSettings, aiDefaultModel: v })}
                                />

                                <Separator />

                                {/* Reset All Settings */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">{t('settings.app.reset')}</h3>
                                    <div className="flex items-center justify-between rounded-lg border border-destructive/20 p-4">
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-foreground">{t('settings.app.resetAll')}</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {t('settings.app.resetAllHint')}
                                            </p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleReset}
                                            className="ml-4 shrink-0 text-destructive hover:text-destructive"
                                        >
                                            {t('settings.app.reset')}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </ScrollArea>
                    </TabsContent>
                    {/* ── Backup Tab ── */}
                    <TabsContent value="backup" className="flex-1 min-h-0">
                        <ScrollArea className="h-full pr-4">
                            <div className="space-y-6 py-4">
                                {!apiClient.isElectron() ? (
                                    <div className="flex items-start gap-3 rounded-lg border border-muted px-4 py-3 text-sm text-muted-foreground">
                                        <Database className="h-4 w-4 mt-0.5 shrink-0" />
                                        <p>{t('settings.backup.electronOnly')}</p>
                                    </div>
                                ) : (
                                    <>
                                        {/* Description */}
                                        <div className="space-y-1">
                                            <h3 className="text-sm font-semibold text-foreground">{t('settings.backup.title')}</h3>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settings.backup.description')}
                                            </p>
                                        </div>

                                        <Separator />

                                        {/* Directory picker */}
                                        <div className="space-y-2">
                                            <Label className="text-sm font-semibold">{t('settings.backup.directory')}</Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    readOnly
                                                    value={backupDir}
                                                    placeholder={t('settings.backup.notConfigured')}
                                                    className="flex-1 font-mono text-xs"
                                                />
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={handleBrowseBackupDir}
                                                    disabled={backupLoading}
                                                    className="shrink-0"
                                                >
                                                    <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                                                    {backupDir ? t('settings.backup.change') : t('settings.backup.browse')}
                                                </Button>
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settings.backup.directoryHint')}
                                            </p>
                                        </div>

                                        <Separator />

                                        {/* Backup on quit toggle */}
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between rounded-lg border p-4">
                                                <div className="flex-1">
                                                    <Label
                                                        htmlFor="backup-on-quit"
                                                        className="text-sm font-medium cursor-pointer"
                                                    >
                                                        {t('settings.backup.backupOnQuit')}
                                                    </Label>
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        {t('settings.backup.backupOnQuitHint')}
                                                    </p>
                                                </div>
                                                <Switch
                                                    id="backup-on-quit"
                                                    checked={backupOnQuit}
                                                    onCheckedChange={setBackupOnQuit}
                                                    disabled={!backupDir}
                                                    className="ml-4 shrink-0"
                                                />
                                            </div>
                                        </div>

                                        <Separator />

                                        {/* Optional encryption passphrase */}
                                        <div className="space-y-3">
                                            <h3 className="text-sm font-semibold text-foreground">{t('settings.backup.passphrase.title')}</h3>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settings.backup.passphrase.description')}
                                            </p>
                                            <div className="rounded-lg border p-4 space-y-3">
                                                <div className="grid gap-2">
                                                    <Label className="text-xs font-medium">{t('settings.backup.passphrase.label')}</Label>
                                                    <Input
                                                        type="password"
                                                        value={backupPassphrase}
                                                        onChange={(e) => setBackupPassphrase(e.target.value)}
                                                        placeholder={t('settings.backup.passphrase.placeholder')}
                                                        disabled={backupLoading || savingBackupPassphrase || !encryptionStatus?.secureStorageAvailable}
                                                    />
                                                    <p className="text-xs text-muted-foreground">
                                                        {!encryptionStatus
                                                            ? t('settings.backup.passphrase.statusUnknown')
                                                            : encryptionStatus.hasEnvPassphrase
                                                                ? t('settings.backup.passphrase.statusEnv')
                                                                : encryptionStatus.hasStoredPassphrase
                                                                    ? t('settings.backup.passphrase.statusStored')
                                                                    : t('settings.backup.passphrase.statusMissing')}
                                                    </p>
                                                </div>
                                                <div className="flex gap-2">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={handleSaveBackupPassphrase}
                                                        disabled={backupLoading || savingBackupPassphrase || !encryptionStatus?.secureStorageAvailable}
                                                    >
                                                        {savingBackupPassphrase
                                                            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                            : <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                                                        }
                                                        {t('settings.backup.passphrase.save')}
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={handleClearBackupPassphrase}
                                                        disabled={backupLoading || savingBackupPassphrase || !encryptionStatus?.secureStorageAvailable}
                                                    >
                                                        {t('settings.backup.passphrase.clear')}
                                                    </Button>
                                                </div>
                                                {!encryptionStatus?.secureStorageAvailable && (
                                                    <p className="text-xs text-destructive">{t('settings.backup.passphrase.unavailable')}</p>
                                                )}

                                                {/* Inline reminder banner (dismissible) */}
                                                {(encryptionStatus && (encryptionStatus.hasEnvPassphrase || encryptionStatus.hasStoredPassphrase) && !reminderDismissed) && (
                                                    <div className="mt-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800">
                                                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                                                        <div className="flex-1">
                                                            <div className="font-medium text-foreground">{t('settings.backup.passphrase.reminderTitle')}</div>
                                                            <div className="text-xs text-muted-foreground mt-1">{t('settings.backup.passphrase.reminderDesc')}</div>
                                                        </div>
                                                        <div className="flex-shrink-0 ml-2">
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                onClick={() => {
                                                                    try {
                                                                        window.localStorage.setItem('vision.backup.passphrase.reminder.dismissed', '1');
                                                                    } catch {}
                                                                    setReminderDismissed(true);
                                                                }}
                                                            >
                                                                {t('settings.backup.passphrase.bannerDismiss')}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        <Separator />

                                        {/* Run backup now */}
                                        <div className="space-y-3">
                                            <h3 className="text-sm font-semibold text-foreground">{t('settings.backup.runNow')}</h3>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={handleBackupNow}
                                                disabled={backupRunning || !backupDir}
                                            >
                                                {backupRunning
                                                    ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                    : <Database className="h-3.5 w-3.5 mr-1.5" />
                                                }
                                                {backupRunning ? t('settings.backup.running') : t('settings.backup.runNow')}
                                            </Button>
                                        </div>

                                        <Separator />

                    {/* Format note */}
                    <div className="flex items-start gap-3 rounded-lg border border-muted bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <p>{t('settings.backup.formatNote')}</p>
                    </div>

                    <Separator />

                    {/* ── Restore Section ── */}
                    <div className="space-y-1">
                        <h3 className="text-sm font-semibold text-foreground">{t('settings.restore.title')}</h3>
                        <p className="text-xs text-muted-foreground">
                            {t('settings.restore.description')}
                        </p>
                    </div>

                    {/* Warning banner */}
                    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <p>{t('settings.restore.warning')}</p>
                    </div>

                    {/* File picker */}
                    <div className="space-y-2">
                        <div className="flex gap-2">
                            <Input
                                readOnly
                                value={restoreFile ? restoreFile.split('/').pop() ?? restoreFile : ''}
                                placeholder={t('settings.restore.noFile')}
                                className="flex-1 font-mono text-xs"
                                title={restoreFile}
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleSelectRestoreFile}
                                disabled={restoreRunning}
                                className="shrink-0"
                            >
                                <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                                {t('settings.restore.selectFile')}
                            </Button>
                        </div>
                    </div>

                    {/* Restore now button */}
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setRestoreConfirmOpen(true)}
                        disabled={restoreRunning || !restoreFile}
                    >
                        {restoreRunning
                            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                            : <UploadCloud className="h-3.5 w-3.5 mr-1.5" />
                        }
                        {restoreRunning ? t('settings.restore.running') : t('settings.restore.runNow')}
                                    </Button>
                                </>
                                )}
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>

                {/* Restore confirmation dialog — rendered outside Tabs so it overlays properly */}
                <AlertDialog open={restoreConfirmOpen} onOpenChange={setRestoreConfirmOpen}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>{t('settings.restore.confirmTitle')}</AlertDialogTitle>
                            <AlertDialogDescription>
                                {t('settings.restore.confirmDesc')}
                                {restoreFile && (
                                    <span className="block mt-2 font-mono text-xs break-all">
                                        {restoreFile.split('/').pop()}
                                    </span>
                                )}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>{t('settings.restore.cancelButton')}</AlertDialogCancel>
                            <AlertDialogAction
                                onClick={handleRestoreConfirmed}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                                {t('settings.restore.confirmButton')}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>

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

interface AIChatSettingsSectionProps {
    value: string | undefined;
    onChange: (model: string) => void;
}

function AIChatSettingsSection({ value, onChange }: AIChatSettingsSectionProps) {
    const { t } = useLanguage();
    const { data: status, isLoading: statusLoading } = useOllamaStatus();
    const { data: models, isLoading: modelsLoading } = useOllamaModels(Boolean(status?.ok));

    const statusDotClass = statusLoading
        ? 'bg-muted-foreground/50'
        : status?.ok
            ? 'bg-emerald-500'
            : 'bg-destructive';

    const statusLabel = statusLoading
        ? t('settings.aiChat.statusChecking')
        : status?.ok
            ? t('settings.aiChat.statusReady')
            : t('settings.aiChat.statusUnreachable');

    const modelOptions = models ?? [];
    const hasModels = modelOptions.length > 0;
    const selectValue = value ?? status?.defaultModel ?? '';

    return (
        <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                {t('settings.aiChat.section')}
            </h3>

            <div className="rounded-lg border p-4 space-y-4">
                <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground">
                        {t('settings.aiChat.status')}
                    </Label>
                    <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${statusDotClass}`} />
                        <span className="text-sm text-foreground">{statusLabel}</span>
                    </div>
                    {(status?.displayUrl || status?.baseUrl) && (
                        <p className="text-xs font-mono text-muted-foreground break-all">
                            {status.displayUrl || status.baseUrl}
                        </p>
                    )}
                    {!status?.ok && !statusLoading && status?.error && (
                        <p className="text-xs text-destructive">{status.error}</p>
                    )}
                    {!status?.ok && !statusLoading && status?.hint && (
                        <p className="text-xs text-muted-foreground">{status.hint}</p>
                    )}
                </div>

                <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground">
                        {t('settings.aiChat.defaultModel')}
                    </Label>
                    <Select
                        value={selectValue || undefined}
                        onValueChange={onChange}
                        disabled={!status?.ok || modelsLoading || !hasModels}
                    >
                        <SelectTrigger>
                            <SelectValue
                                placeholder={
                                    !status?.ok
                                        ? t('settings.aiChat.statusUnreachable')
                                        : modelsLoading
                                            ? t('settings.aiChat.loadingModels')
                                            : hasModels
                                                ? t('settings.aiChat.selectModel')
                                                : t('settings.aiChat.noModels')
                                }
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {modelOptions.map((m) => (
                                <SelectItem key={m.name} value={m.name}>
                                    {m.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.aiChat.defaultModelHint')}
                    </p>
                </div>
            </div>
        </div>
    );
}
