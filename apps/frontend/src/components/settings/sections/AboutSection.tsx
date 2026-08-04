import { useState, memo } from 'react';
import { safeHref } from '@/utils/safeHref';
import {
    AlertCircle, CheckCircle2, Download, ExternalLink, Loader2,
    RefreshCw, RotateCcw, Sparkles, ShieldCheck,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { useOnboarding } from '@/components/onboarding/OnboardingWizard';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDateStringWithAppSettings } from '@/components/shared/dateUtils';
import { SettingsSection, SettingsGroup, SettingRow } from '../SettingsPrimitives';
import { electronErrorToMessage } from '@/lib/api/electronErrorMessage';

type UpdateStatus = {
    up_to_date: boolean;
    current_version: string;
    latest_version: string | null;
    published_at?: string;
    release_notes?: string;
    html_url?: string;
    /** 'docker-compose' comes from the HTTP route — non-Electron, no in-app installer. */
    update_mode?: 'source' | 'docker' | 'dev' | 'docker-compose';
    error?: string;
} | null;

type ApplyPhase = 'idle' | 'backing-up' | 'downloading' | 'pulling' | 'restarting' | 'done';

interface AboutSectionProps {
    onOpenChange: (open: boolean) => void;
}

export const AboutSection = memo(function AboutSection({ onOpenChange }: AboutSectionProps) {
    const { t } = useLanguage();
    const { reset: resetOnboarding } = useOnboarding();
    const { appSettings, updateAppSettings, resetAppSettings } = useAppSettings();
    const { resetSettings } = useSettings();
    const queryClient = useQueryClient();

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
        const mode = updateStatus?.update_mode ?? 'source';

        if (apiClient.isElectron()) {
            setApplyPhase('backing-up');
            try {
                const backupResult = await apiClient.preUpdateBackup();
                if (backupResult && !backupResult.success) {
                    toast.error(t('update.backupFailed'), { description: electronErrorToMessage(backupResult.error, t) });
                    setApplyPhase('idle');
                    return;
                }
            } catch (err: unknown) {
                const msg = electronErrorToMessage(err, t);
                toast.error(t('update.backupFailed'), { description: msg });
                setApplyPhase('idle');
                return;
            }
        }

        if (mode === 'docker') {
            setApplyPhase('pulling');
            try {
                const result = await apiClient.triggerDockerUpdate();
                if (!result?.success) {
                    toast.error(t('settings.app.updateFailed'), { description: electronErrorToMessage(result?.error, t) });
                    setApplyPhase('idle');
                    return;
                }
                setApplyPhase('restarting');
                toast.success(t('settings.app.updateComplete'), {
                    description: t('settings.app.nowRunning', { version: updateStatus?.latest_version ?? '' }),
                    duration: 8000,
                });
                setApplyPhase('done');
            } catch (err: unknown) {
                const msg = electronErrorToMessage(err, t);
                toast.error(t('settings.app.updateFailed'), { description: msg });
                setApplyPhase('idle');
            }
            return;
        }

        setApplyPhase('downloading');
        try {
            const result = await apiClient.installShellUpdate();
            if (result === null) {
                toast.info(t('settings.app.updateAutoApply'));
                setApplyPhase('idle');
                return;
            }
            // No installable source-launcher asset on this release — the main
            // process opened the release page. A redirect, not a failure.
            if (result.manual_download) {
                toast.info(t('update.manualDownload'));
                setApplyPhase('idle');
                return;
            }
            if (!result.success) {
                toast.error(t('settings.app.updateFailed'), { description: electronErrorToMessage(result.error, t) });
                setApplyPhase('idle');
                return;
            }
            setApplyPhase('restarting');
            toast.success(t('settings.app.updateComplete'), {
                description: t('settings.app.nowRunning', { version: result.version ?? (updateStatus?.latest_version ?? '') }),
                duration: 8000,
            });
        } catch (err: unknown) {
            const msg = electronErrorToMessage(err, t);
            toast.error(t('settings.app.updateFailed'), { description: msg });
            setApplyPhase('idle');
        }
    };

    const handleResetAll = () => {
        resetSettings();
        resetAppSettings(); // also clears the session tier override
        apiClient.saveSetting('includeTransfers', false)
            .then(() => queryClient.invalidateQueries())
            .catch(() => { /* non-fatal */ });
        toast.info(t('settings.resetToDefaults'));
    };

    return (
        <SettingsSection
            title={t('settings.section.about')}
            description={t('settings.section.about.desc')}
        >
            {/* Updates */}
            <SettingsGroup label={t('settings.app.updates')}>
                <SettingRow
                    title={t('settings.app.checkForUpdates')}
                    description={apiClient.isElectron() ? t('settings.app.updatesHintElectron') : t('settings.app.updatesHintWeb')}
                    layout="stack"
                >
                    {updateStatus && (
                        <div className={cn(
                            'mb-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
                            updateStatus.up_to_date
                                ? 'border-success/30 bg-success/5 text-success'
                                : 'border-warning/30 bg-warning/5 text-warning'
                        )}>
                            {updateStatus.up_to_date
                                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                            <div className="min-w-0 flex-1">
                                {updateStatus.up_to_date ? (
                                    <p>{t('settings.app.runningLatest')}{updateStatus.current_version ? ` (${updateStatus.current_version})` : ''}.</p>
                                ) : (
                                    <>
                                        <p className="font-medium">
                                            {t('settings.app.versionAvailable', { version: updateStatus.latest_version ?? '' })}
                                            {updateStatus.current_version ? ` (${t('settings.app.current')} ${updateStatus.current_version})` : ''}.
                                        </p>
                                        {updateStatus.published_at && (
                                            <p className="mt-0.5 text-xs opacity-80">
                                                {t('settings.app.released')} {formatDateStringWithAppSettings(updateStatus.published_at, appSettings.dateFormat)}
                                            </p>
                                        )}
                                        {updateStatus.release_notes && (
                                            <p className="mt-1 line-clamp-2 text-xs opacity-80">{updateStatus.release_notes}</p>
                                        )}
                                    </>
                                )}
                                {updateStatus.error && <p className="mt-0.5 text-xs opacity-80">{updateStatus.error}</p>}
                            </div>
                            {/* Gate on the resolved href: a rejected URL used to
                                leave this icon rendered, hoverable and tooltipped,
                                pointing at nothing. */}
                            {safeHref(updateStatus.html_url) && (
                                <a href={safeHref(updateStatus.html_url)} target="_blank" rel="noopener noreferrer" className="shrink-0 opacity-70 transition-opacity hover:opacity-100" title={t('update.releaseNotes')}>
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            )}
                        </div>
                    )}

                    {applyingUpdate && (
                        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {applyPhase === 'backing-up' ? t('update.backingUp') :
                                applyPhase === 'downloading' ? t('update.downloading') :
                                    applyPhase === 'pulling' ? t('settings.app.pulling') :
                                        t('settings.app.restarting')}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => { void handleCheckForUpdates(); }} disabled={checkingUpdate || applyingUpdate}>
                            {checkingUpdate
                                ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                            {t('settings.app.checkForUpdates')}
                        </Button>
                        {apiClient.isElectron() && updateStatus && !updateStatus.up_to_date && (
                            <Button size="sm" onClick={() => { void handleApplyUpdate(); }} disabled={applyingUpdate || checkingUpdate}>
                                {applyingUpdate
                                    ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                    : <Download className="mr-1.5 h-3.5 w-3.5" />}
                                {applyPhase === 'restarting' ? t('settings.app.restarting2') :
                                    applyingUpdate ? t('update.installing') :
                                        t('settings.app.installUpdate')}
                            </Button>
                        )}
                    </div>
                </SettingRow>
            </SettingsGroup>

            {/* Setup & developer */}
            <SettingsGroup>
                <SettingRow
                    title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />{t('settings.app.onboardingWizard')}</span>}
                    description={t('settings.app.onboardingWizardHint')}
                >
                    <Button variant="outline" size="sm" onClick={handleRestartOnboarding}>
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        {t('settings.app.restart')}
                    </Button>
                </SettingRow>

                <SettingRow
                    title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" />{t('settings.app.adminMode')}</span>}
                    description={t('settings.app.adminModeHint')}
                    htmlFor="admin-mode"
                >
                    <Switch
                        id="admin-mode"
                        checked={appSettings.adminMode ?? false}
                        onCheckedChange={(v) => updateAppSettings({ adminMode: v })}
                    />
                </SettingRow>
            </SettingsGroup>

            {/* Danger zone */}
            <SettingsGroup label={t('settings.app.reset')} className="border-destructive/30">
                <SettingRow title={t('settings.app.resetAll')} description={t('settings.app.resetAllHint')} destructive>
                    <Button variant="outline" size="sm" onClick={handleResetAll} className="text-destructive hover:text-destructive">
                        {t('settings.app.reset')}
                    </Button>
                </SettingRow>
            </SettingsGroup>
        </SettingsSection>
    );
});
