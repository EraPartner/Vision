import { useState, memo } from 'react';
import {
    AlertCircle, CheckCircle2, Download, ExternalLink, Loader2,
    RefreshCw, RotateCcw, Sparkles, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { useOnboarding } from '@/components/onboarding/OnboardingWizard';
import { apiClient } from '@/lib/api';
import { formatDateStringWithAppSettings } from '@/components/shared/dateUtils';
import { AIChatSettingsSection } from '@/components/settings/AIChatSettingsSection';

type UpdateStatus = {
    up_to_date: boolean;
    current_version: string;
    latest_version: string | null;
    published_at?: string;
    release_notes?: string;
    html_url?: string;
    error?: string;
} | null;

type ApplyPhase = 'idle' | 'pulling' | 'restarting' | 'done';

interface AppTabProps {
    aiDefaultModel: string | undefined;
    onAiModelChange: (model: string) => void;
    onReset: () => void;
    onOpenChange: (open: boolean) => void;
    dateFormat: string;
    adminMode: boolean;
    onAdminModeChange: (enabled: boolean) => void;
}

export const AppTab = memo(function AppTab({
    aiDefaultModel,
    onAiModelChange,
    onReset,
    onOpenChange,
    dateFormat,
    adminMode,
    onAdminModeChange,
}: AppTabProps) {
    const { t } = useLanguage();
    const { reset: resetOnboarding } = useOnboarding();

    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(null);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [applyPhase, setApplyPhase] = useState<ApplyPhase>('idle');
    const applyingUpdate = applyPhase !== 'idle' && applyPhase !== 'done';

    const handleRestartOnboarding = () => {
        resetOnboarding();
        onOpenChange(false);
        toast.success(t('settings.app.onboardingRestarted'));
        setTimeout(() => window.location.reload(), 500);
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

    const handleApplyUpdate = async () => {
        setApplyPhase('pulling');
        try {
            const result = await apiClient.installShellUpdate();
            if (result === null) {
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

    const handleResetRecurringDismissals = async () => {
        const DISMISSED_RECURRING_PATTERNS_KEY = 'dismissed_recurring_patterns';
        try {
            window.localStorage.removeItem(DISMISSED_RECURRING_PATTERNS_KEY);
        } catch {
            // ignore
        }
        try {
            await apiClient.saveSetting(DISMISSED_RECURRING_PATTERNS_KEY, []);
            toast.success(t('settings.app.recurringDismissalsResetSuccess'));
        } catch {
            toast.error(t('settings.app.recurringDismissalsResetFailed'));
        }
    };

    return (
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
                                                {t('settings.app.released')} {formatDateStringWithAppSettings(updateStatus.published_at, dateFormat)}
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
                            onClick={() => { void handleCheckForUpdates(); }}
                            disabled={checkingUpdate || applyingUpdate}
                        >
                            {checkingUpdate
                                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                            }
                            {t('settings.app.checkForUpdates')}
                        </Button>

                        {apiClient.isElectron() && updateStatus && !updateStatus.up_to_date && (
                            <Button
                                size="sm"
                                onClick={() => { void handleApplyUpdate(); }}
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
                            onClick={() => { void handleResetRecurringDismissals(); }}
                            className="ml-4 shrink-0"
                        >
                            {t('settings.app.reset')}
                        </Button>
                    </div>
                </div>

                <Separator />

                {/* AI Chat */}
                <AIChatSettingsSection
                    value={aiDefaultModel}
                    onChange={onAiModelChange}
                />

                <Separator />

                {/* Developer */}
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-foreground">{t('settings.app.developer')}</h3>
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="flex-1">
                            <p className="text-sm font-medium text-foreground flex items-center gap-2">
                                <ShieldCheck className="h-4 w-4 text-primary" />
                                {t('settings.app.adminMode')}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                                {t('settings.app.adminModeHint')}
                            </p>
                        </div>
                        <Switch
                            checked={adminMode}
                            onCheckedChange={onAdminModeChange}
                            className="ml-4 shrink-0"
                        />
                    </div>
                </div>

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
                            onClick={onReset}
                            className="ml-4 shrink-0 text-destructive hover:text-destructive"
                        >
                            {t('settings.app.reset')}
                        </Button>
                    </div>
                </div>
            </div>
        </ScrollArea>
    );
});
