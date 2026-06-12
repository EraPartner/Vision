import { memo } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { THEME_VARIANTS, themes, type ThemeVariant } from '@/styles/themes';
import { isElectronMac } from '@/lib/api/electron';
import type { AppSettings } from '@/contexts/AppSettingsContext';
import { useSettingsStore, type VisualEffectsTier } from '@/stores/settingsStore';
import { useLargeDisplay } from '@/hooks/useVisualEffectsTier';

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
    'background',
    'primary',
    'accent',
    'chart-3',
    'chart-4',
    'destructive',
] as const;

interface SwatchProps {
    variant: ThemeVariant;
    mode: 'light' | 'dark';
}

function VariantSwatch({ variant, mode }: SwatchProps) {
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

interface AppearanceTabProps {
    localAppSettings: AppSettings;
    onUpdate: (s: AppSettings) => void;
    /** Staged tier pick; null = untouched (dialog routes it on Save — ADR-075 addendum). */
    tierSelection: VisualEffectsTier | null;
    onTierSelect: (tier: VisualEffectsTier) => void;
}

export const AppearanceTab = memo(function AppearanceTab({
    localAppSettings, onUpdate, tierSelection, onTierSelect,
}: AppearanceTabProps) {
    const { t } = useLanguage();
    const { theme, mode, schedule, variant, systemAccent, setMode, setSchedule, setVariant, setSystemAccent } = useTheme();

    // The select shows the tier currently in use on this display, not the
    // synced preference: while the auto-adapt cap is active that is the
    // session override (or 'reduced'), otherwise the preference.
    const largeDisplay = useLargeDisplay();
    const sessionTierOverride = useSettingsStore((s) => s.sessionTierOverride);
    const capped = (localAppSettings.autoAdaptDisplay ?? true) && largeDisplay;
    const tierInUse = capped
        ? (sessionTierOverride ?? 'reduced')
        : (localAppSettings.visualEffects ?? 'standard');
    const shownTier = tierSelection ?? tierInUse;

    return (
        <ScrollArea className="h-full pr-4">
        <div className="space-y-6 py-4">
            {/* Variant */}
            <div className="space-y-3">
                <div className="space-y-1">
                    <Label className="text-sm font-semibold">{t('settings.appearance.variant')}</Label>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.appearance.variantHint')}
                    </p>
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
                                    <span className="text-xs text-muted-foreground">
                                        {t(v.descKey)}
                                    </span>
                                </div>
                                <VariantSwatch variant={v.value} mode={theme} />
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* macOS system accent (Electron shell only) */}
            {isElectronMac() && (
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
                    <div className="space-y-1">
                        <Label htmlFor="system-accent" className="text-sm font-medium">
                            {t('settings.appearance.systemAccent')}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            {t('settings.appearance.systemAccentHint')}
                        </p>
                    </div>
                    <Switch
                        id="system-accent"
                        checked={systemAccent}
                        onCheckedChange={setSystemAccent}
                    />
                </div>
            )}

            <Separator />

            {/* Mode */}
            <div className="space-y-2">
                <Label className="text-sm font-semibold">{t('settings.appearance.mode')}</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="light">{t('settings.appearance.modes.light')}</SelectItem>
                        <SelectItem value="dark">{t('settings.appearance.modes.dark')}</SelectItem>
                        <SelectItem value="system">{t('settings.appearance.modes.system')}</SelectItem>
                        <SelectItem value="schedule">{t('settings.appearance.modes.schedule')}</SelectItem>
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                    {t('settings.appearance.modeHint')}
                </p>
            </div>

            {mode === 'schedule' && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
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
            )}

            <Separator />

            {/* Visual-effects tier (ADR-075) — shows the tier in use on this
                display; the dialog routes a changed pick on Save to either
                the synced preference or a session-only override. */}
            <div className="space-y-2">
                <Label className="text-sm font-semibold">{t('settings.appearance.visualEffects')}</Label>
                <Select
                    value={shownTier}
                    onValueChange={(v) => onTierSelect(v as VisualEffectsTier)}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="reduced">{t('settings.appearance.visualEffects.reduced')}</SelectItem>
                        <SelectItem value="standard">{t('settings.appearance.visualEffects.standard')}</SelectItem>
                        <SelectItem value="enhanced">{t('settings.appearance.visualEffects.enhanced')}</SelectItem>
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                    {t('settings.appearance.visualEffectsHint')}
                </p>
                {capped && shownTier === 'reduced' && (
                    <p className="text-xs font-medium text-primary">
                        {t('settings.appearance.visualEffectsAutoNote')}
                    </p>
                )}
                {capped && shownTier !== 'reduced' && (
                    <p className="text-xs font-medium text-warning">
                        {t('settings.appearance.visualEffectsOverrideNote')}
                    </p>
                )}
            </div>

            {/* Auto-adapt: cap at Reduced while the window is on a large display */}
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                    <Label htmlFor="auto-adapt-display" className="text-sm font-semibold">
                        {t('settings.appearance.autoAdaptDisplay')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.appearance.autoAdaptDisplayHint')}
                    </p>
                </div>
                <Switch
                    id="auto-adapt-display"
                    checked={localAppSettings.autoAdaptDisplay ?? true}
                    onCheckedChange={(v) => onUpdate({ ...localAppSettings, autoAdaptDisplay: v })}
                />
            </div>
        </div>
        </ScrollArea>
    );
});

export { THEME_VARIANTS };
