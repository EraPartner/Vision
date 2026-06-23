import { memo } from 'react';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { SettingsSection, SettingsGroup, SettingRow } from '../SettingsPrimitives';

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

export const GeneralSection = memo(function GeneralSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

    return (
        <SettingsSection
            title={t('settings.tab.general')}
            description={t('settings.section.general.desc')}
        >
            <SettingsGroup label={t('settings.group.formatting')}>
                <SettingRow title={t('settings.general.currency')} description={t('settings.general.currencyHint')} layout="stack">
                    <Select
                        value={appSettings.defaultCurrency}
                        onValueChange={(v) => updateAppSettings({ defaultCurrency: v })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow title={t('settings.general.numberFormat')} layout="stack">
                    <Select
                        value={appSettings.numberFormat}
                        onValueChange={(v) => updateAppSettings({ numberFormat: v })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {NUMBER_FORMATS.map((f) => <SelectItem key={f.value} value={f.value}>{t(f.labelKey)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow title={t('settings.general.decimalPlaces')} layout="stack">
                    <Select
                        value={String(appSettings.showDecimalPlaces)}
                        onValueChange={(v) => updateAppSettings({ showDecimalPlaces: Number(v) })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="0">0 (1,234)</SelectItem>
                            <SelectItem value="1">1 (1,234.5)</SelectItem>
                            <SelectItem value="2">2 (1,234.56)</SelectItem>
                            <SelectItem value="3">3 (1,234.567)</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow title={t('settings.general.dateFormat')} layout="stack">
                    <Select
                        value={appSettings.dateFormat}
                        onValueChange={(v) => updateAppSettings({ dateFormat: v })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {DATE_FORMATS.map((f) => <SelectItem key={f.value} value={f.value}>{t(f.labelKey)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup label={t('settings.group.localeDisplay')}>
                <SettingRow title={t('settings.general.language')} description={t('settings.general.languageHint')} layout="stack">
                    <Select
                        value={appSettings.language ?? 'en'}
                        onValueChange={(v) => updateAppSettings({ language: v as 'en' | 'nl' })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="en">{t('settings.general.lang.en')}</SelectItem>
                            <SelectItem value="nl">{t('settings.general.lang.nl')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow title={t('settings.general.startOfWeek')} layout="stack">
                    <Select
                        value={appSettings.startOfWeek}
                        onValueChange={(v) => updateAppSettings({ startOfWeek: v as 'monday' | 'sunday' })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="monday">{t('settings.general.monday')}</SelectItem>
                            <SelectItem value="sunday">{t('settings.general.sunday')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow title={t('settings.general.pageSize')} description={t('settings.general.pageSizeHint')} layout="stack">
                    <Select
                        value={String(appSettings.defaultPageSize)}
                        onValueChange={(v) => updateAppSettings({ defaultPageSize: Number(v) })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="25">25 {t('settings.general.rows')}</SelectItem>
                            <SelectItem value="50">50 {t('settings.general.rows')}</SelectItem>
                            <SelectItem value="100">100 {t('settings.general.rows')}</SelectItem>
                            <SelectItem value="200">200 {t('settings.general.rows')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
            </SettingsGroup>
        </SettingsSection>
    );
});
