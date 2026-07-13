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

interface SelectRowConfig {
    title: string;
    description?: string;
    value: string;
    onValueChange: (v: string) => void;
    options: { value: string; label: string }[];
}

// One SettingRow→Select block; the seven rows here were identical apart from
// their title/value/options/change handler, now expressed as config.
function SelectSettingRow({ title, description, value, onValueChange, options }: SelectRowConfig) {
    return (
        <SettingRow title={title} description={description} layout="stack">
            <Select value={value} onValueChange={onValueChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                    {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
            </Select>
        </SettingRow>
    );
}

export const GeneralSection = memo(function GeneralSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

    const formattingRows: SelectRowConfig[] = [
        {
            title: t('settings.general.currency'),
            description: t('settings.general.currencyHint'),
            value: appSettings.defaultCurrency,
            onValueChange: (v) => updateAppSettings({ defaultCurrency: v }),
            options: CURRENCIES.map((c) => ({ value: c, label: c })),
        },
        {
            title: t('settings.general.numberFormat'),
            value: appSettings.numberFormat,
            onValueChange: (v) => updateAppSettings({ numberFormat: v }),
            options: NUMBER_FORMATS.map((f) => ({ value: f.value, label: t(f.labelKey) })),
        },
        {
            title: t('settings.general.decimalPlaces'),
            value: String(appSettings.showDecimalPlaces),
            onValueChange: (v) => updateAppSettings({ showDecimalPlaces: Number(v) }),
            options: [
                { value: '0', label: '0 (1,234)' },
                { value: '1', label: '1 (1,234.5)' },
                { value: '2', label: '2 (1,234.56)' },
                { value: '3', label: '3 (1,234.567)' },
            ],
        },
        {
            title: t('settings.general.dateFormat'),
            value: appSettings.dateFormat,
            onValueChange: (v) => updateAppSettings({ dateFormat: v }),
            options: DATE_FORMATS.map((f) => ({ value: f.value, label: t(f.labelKey) })),
        },
    ];

    const localeRows: SelectRowConfig[] = [
        {
            title: t('settings.general.language'),
            description: t('settings.general.languageHint'),
            value: appSettings.language ?? 'en',
            onValueChange: (v) => updateAppSettings({ language: v as 'en' | 'nl' }),
            options: [
                { value: 'en', label: t('settings.general.lang.en') },
                { value: 'nl', label: t('settings.general.lang.nl') },
            ],
        },
        {
            title: t('settings.general.startOfWeek'),
            value: appSettings.startOfWeek,
            onValueChange: (v) => updateAppSettings({ startOfWeek: v as 'monday' | 'sunday' }),
            options: [
                { value: 'monday', label: t('settings.general.monday') },
                { value: 'sunday', label: t('settings.general.sunday') },
            ],
        },
        {
            title: t('settings.general.pageSize'),
            description: t('settings.general.pageSizeHint'),
            value: String(appSettings.defaultPageSize),
            onValueChange: (v) => updateAppSettings({ defaultPageSize: Number(v) }),
            options: [
                { value: '25', label: `25 ${t('settings.general.rows')}` },
                { value: '50', label: `50 ${t('settings.general.rows')}` },
                { value: '100', label: `100 ${t('settings.general.rows')}` },
                { value: '200', label: `200 ${t('settings.general.rows')}` },
            ],
        },
    ];

    return (
        <SettingsSection
            title={t('settings.tab.general')}
            description={t('settings.section.general.desc')}
        >
            <SettingsGroup label={t('settings.group.formatting')}>
                {formattingRows.map((row) => <SelectSettingRow key={row.title} {...row} />)}
            </SettingsGroup>

            <SettingsGroup label={t('settings.group.localeDisplay')}>
                {localeRows.map((row) => <SelectSettingRow key={row.title} {...row} />)}
            </SettingsGroup>
        </SettingsSection>
    );
});
