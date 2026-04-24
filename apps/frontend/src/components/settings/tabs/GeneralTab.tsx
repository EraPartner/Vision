import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import type { AppSettings } from '@/contexts/AppSettingsContext';
import type { CostBasisMethod } from '@/stores/settingsStore';

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

interface GeneralTabProps {
    localAppSettings: AppSettings;
    onUpdate: (s: AppSettings) => void;
}

export function GeneralTab({ localAppSettings, onUpdate }: GeneralTabProps) {
    const { t } = useLanguage();

    return (
        <ScrollArea className="h-full pr-4">
            <div className="space-y-6 py-4">
                {/* Currency */}
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">{t('settings.general.currency')}</Label>
                    <Select
                        value={localAppSettings.defaultCurrency}
                        onValueChange={(v) => onUpdate({ ...localAppSettings, defaultCurrency: v })}
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
                        onValueChange={(v) => onUpdate({ ...localAppSettings, dateFormat: v })}
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
                        onValueChange={(v) => onUpdate({ ...localAppSettings, numberFormat: v })}
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
                        onValueChange={(v) => onUpdate({ ...localAppSettings, showDecimalPlaces: Number(v) })}
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
                        onValueChange={(v) => onUpdate({ ...localAppSettings, startOfWeek: v as 'monday' | 'sunday' })}
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
                        onValueChange={(v) => onUpdate({ ...localAppSettings, defaultPageSize: Number(v) })}
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
                        onValueChange={(v) => onUpdate({ ...localAppSettings, language: v as 'en' | 'nl' })}
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

                <Separator />

                {/* Cost Basis Method */}
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">{t('settings.general.costBasisMethod')}</Label>
                    <Select
                        value={localAppSettings.costBasisMethod ?? 'weighted_avg'}
                        onValueChange={(v) => onUpdate({ ...localAppSettings, costBasisMethod: v as CostBasisMethod })}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="weighted_avg">{t('settings.general.costBasisMethod.weighted_avg')}</SelectItem>
                            <SelectItem value="fifo">{t('settings.general.costBasisMethod.fifo')}</SelectItem>
                            <SelectItem value="lifo">{t('settings.general.costBasisMethod.lifo')}</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.general.costBasisMethodHint')}
                    </p>
                </div>
            </div>
        </ScrollArea>
    );
}
