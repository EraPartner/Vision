import { memo } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { themes, type ThemeVariant } from '@/styles/themes';
import { isElectronMac } from '@/lib/api/electron';
import { useSettingsStore, type VisualEffectsTier } from '@/stores/settingsStore';
import { useLargeDisplay } from '@/hooks/useVisualEffectsTier';
import { SettingsSection, SettingsGroup, SettingRow } from '../SettingsPrimitives';

interface VariantMeta {
    value: ThemeVariant;
    labelKey: string;
    descKey: string;
}

const VARIANT_META: VariantMeta[] = [
    { value: 'default', labelKey: 'settings.appearance.variants.default', descKey: 'settings.appearance.variantsDesc.default' },
    { value: 'dracula', labelKey: 'settings.appearance.variants.dracula', descKey: 'settings.appearance.variantsDesc.dracula' },
    { value: 'solarized', labelKey: 'settings.appearance.variants.solarized', descKey: 'settings.appearance.variantsDesc.solarized' },
    { value: 'nord', labelKey: 'settings.appearance.variants.nord', descKey: 'settings.appearance.variantsDesc.nord' },
    { value: 'high-contrast', labelKey: 'settings.appearance.variants.highContrast', descKey: 'settings.appearance.variantsDesc.highContrast' },
];

const SWATCH_TOKENS = [
    'background', 'primary', 'accent', 'chart-3', 'chart-4', 'destructive',
] as const;

function VariantSwatch({ variant, mode }: { variant: ThemeVariant; mode: 'light' | 'dark' }) {
    const palette = themes[variant][mode];
    return (
        <div className="flex items-center gap-1">
            {SWATCH_TOKENS.map((token) => (
                <span
                    key={token}
                    className="h-4 w-4 rounded-full border border-border/40"
                    style={{ backgroundColor: `hsl(${palette[token]})` }}
                    aria-hidden
                />
            ))}
        </div>
    );
}

export const AppearanceSection = memo(function AppearanceSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();
    const { theme, mode, schedule, variant, systemAccent, setMode, setSchedule, setVariant, setSystemAccent } = useTheme();

    // The effects select shows the tier in use on THIS display: while the
    // auto-adapt cap is active that is the session override (or 'reduced'),
    // otherwise the synced preference. Instant-apply routes a changed pick
    // immediately — to the session override under the cap, else the preference.
    const largeDisplay = useLargeDisplay();
    const setSessionTierOverride = useSettingsStore((s) => s.setSessionTierOverride);
    const sessionTierOverride = useSettingsStore((s) => s.sessionTierOverride);
    const capped = (appSettings.autoAdaptDisplay ?? true) && largeDisplay;
    const tierInUse: VisualEffectsTier = capped
        ? (sessionTierOverride ?? 'reduced')
        : (appSettings.visualEffects ?? 'standard');

    const handleTierChange = (tier: VisualEffectsTier) => {
        if (capped) {
            // Capped display: the pick is a session-only, this-device override of
            // the cap; the synced preference stays untouched. Picking 'reduced'
            // (= what the cap gives) clears the override.
            setSessionTierOverride(tier === 'reduced' ? undefined : tier);
        } else {
            updateAppSettings({ visualEffects: tier });
            setSessionTierOverride(undefined);
        }
    };

    const handleAutoAdaptChange = (v: boolean) => {
        // Toggling auto hands tier control back to the cap — drop any override.
        updateAppSettings({ autoAdaptDisplay: v });
        setSessionTierOverride(undefined);
    };

    return (
        <SettingsSection
            title={t('settings.tab.appearance')}
            description={t('settings.section.appearance.desc')}
        >
            {/* Theme variant — selectable swatch cards */}
            <div className="space-y-3">
                <div className="space-y-0.5">
                    <p className="text-sm font-medium text-foreground">{t('settings.appearance.variant')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.appearance.variantHint')}</p>
                </div>
                <div className="grid grid-cols-1 gap-2">
                    {VARIANT_META.map((v) => {
                        const active = variant === v.value;
                        return (
                            <button
                                key={v.value}
                                type="button"
                                onClick={() => setVariant(v.value)}
                                className={
                                    'flex items-center justify-between rounded-lg border p-3 text-left transition-colors ' +
                                    (active
                                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                                        : 'border-border hover:bg-muted/60')
                                }
                                aria-pressed={active}
                            >
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">{t(v.labelKey)}</span>
                                    <span className="text-xs text-muted-foreground">{t(v.descKey)}</span>
                                </div>
                                <VariantSwatch variant={v.value} mode={theme} />
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Color mode */}
            <SettingsGroup label={t('settings.group.colorMode')}>
                <SettingRow title={t('settings.appearance.mode')} description={t('settings.appearance.modeHint')} layout="stack">
                    <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="light">{t('settings.appearance.modes.light')}</SelectItem>
                            <SelectItem value="dark">{t('settings.appearance.modes.dark')}</SelectItem>
                            <SelectItem value="system">{t('settings.appearance.modes.system')}</SelectItem>
                            <SelectItem value="schedule">{t('settings.appearance.modes.schedule')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

                {mode === 'schedule' && (
                    <SettingRow title={t('settings.appearance.modes.schedule')} layout="stack">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <Label className="text-xs">{t('settings.appearance.lightFrom')}</Label>
                                <Input
                                    type="time"
                                    value={schedule.lightFrom}
                                    onChange={(e) => setSchedule({ ...schedule, lightFrom: e.target.value })}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs">{t('settings.appearance.darkFrom')}</Label>
                                <Input
                                    type="time"
                                    value={schedule.darkFrom}
                                    onChange={(e) => setSchedule({ ...schedule, darkFrom: e.target.value })}
                                />
                            </div>
                        </div>
                    </SettingRow>
                )}

                {isElectronMac() && (
                    <SettingRow
                        title={t('settings.appearance.systemAccent')}
                        description={t('settings.appearance.systemAccentHint')}
                        htmlFor="system-accent"
                    >
                        <Switch id="system-accent" checked={systemAccent} onCheckedChange={setSystemAccent} />
                    </SettingRow>
                )}
            </SettingsGroup>

            {/* Visual effects */}
            <SettingsGroup label={t('settings.group.visualEffects')}>
                <SettingRow title={t('settings.appearance.visualEffects')} description={t('settings.appearance.visualEffectsHint')} layout="stack">
                    <Select value={tierInUse} onValueChange={(v) => handleTierChange(v as VisualEffectsTier)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="reduced">{t('settings.appearance.visualEffects.reduced')}</SelectItem>
                            <SelectItem value="standard">{t('settings.appearance.visualEffects.standard')}</SelectItem>
                            <SelectItem value="enhanced">{t('settings.appearance.visualEffects.enhanced')}</SelectItem>
                        </SelectContent>
                    </Select>
                    {capped && tierInUse === 'reduced' && (
                        <p className="mt-2 text-xs font-medium text-primary">{t('settings.appearance.visualEffectsAutoNote')}</p>
                    )}
                    {capped && tierInUse !== 'reduced' && (
                        <p className="mt-2 text-xs font-medium text-warning">{t('settings.appearance.visualEffectsOverrideNote')}</p>
                    )}
                </SettingRow>

                <SettingRow
                    title={t('settings.appearance.autoAdaptDisplay')}
                    description={t('settings.appearance.autoAdaptDisplayHint')}
                    htmlFor="auto-adapt-display"
                >
                    <Switch
                        id="auto-adapt-display"
                        checked={appSettings.autoAdaptDisplay ?? true}
                        onCheckedChange={handleAutoAdaptChange}
                    />
                </SettingRow>
            </SettingsGroup>
        </SettingsSection>
    );
});
