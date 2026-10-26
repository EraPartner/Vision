import { selectRow } from "../selectRow";
import { memo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    SettingsSection,
    SettingsGroup,
    SelectSettingRow,
    type SelectRowConfig,
} from "../SettingsPrimitives";
import {
    SUPPORTED_CURRENCIES as CURRENCIES,
    type NumberFormat,
    numberFormatToLocale,
} from "@/utils/currency";
import type { AppDateFormat } from "@/stores/settingsStore";
import { asCurrencyCode } from "@vision/types/brands";
import type { TranslationKey } from "@/locales/keys";

const DATE_FORMATS = [
    { value: "DD/MM/YYYY", labelKey: "settings.dateFormat.ddmmyyyy" },
    { value: "MM/DD/YYYY", labelKey: "settings.dateFormat.mmddyyyy" },
    { value: "YYYY-MM-DD", labelKey: "settings.dateFormat.yyyymmdd" },
    { value: "DD.MM.YYYY", labelKey: "settings.dateFormat.ddmmyyyy2" },
    { value: "DD-MM-YYYY", labelKey: "settings.dateFormat.ddmmyyyy3" },
] satisfies ReadonlyArray<{ value: AppDateFormat; labelKey: TranslationKey }>;

const NUMBER_FORMATS = [
    { value: "eu", labelKey: "settings.numberFormat.eu" },
    { value: "us", labelKey: "settings.numberFormat.us" },
    { value: "ch", labelKey: "settings.numberFormat.ch" },
    { value: "in", labelKey: "settings.numberFormat.in" },
] satisfies ReadonlyArray<{ value: NumberFormat; labelKey: TranslationKey }>;

export const GeneralSection = memo(function GeneralSection() {
    const { t } = useLanguage();
    const { appSettings, updateAppSettings } = useAppSettings();

    const formattingRows: SelectRowConfig[] = [
        {
            title: t("settings.general.currency"),
            description: t("settings.general.currencyHint"),
            value: appSettings.defaultCurrency,
            onValueChange: (v) =>
                updateAppSettings({ defaultCurrency: asCurrencyCode(v) }),
            options: CURRENCIES.map((c) => ({ value: c, label: c })),
        },
        {
            title: t("settings.general.numberFormat"),
            value: appSettings.numberFormat,
            onValueChange: (v) => {
                const selected = NUMBER_FORMATS.find(
                    (format) => format.value === v,
                );
                if (selected)
                    updateAppSettings({ numberFormat: selected.value });
            },
            options: NUMBER_FORMATS.map((f) => ({
                value: f.value,
                label: t(f.labelKey),
            })),
        },
        {
            title: t("settings.general.decimalPlaces"),
            value: String(appSettings.showDecimalPlaces),
            onValueChange: (v) =>
                updateAppSettings({ showDecimalPlaces: Number(v) }),
            options: [0, 1, 2, 3].map((digits) => ({
                value: String(digits),
                label: `${digits} (${new Intl.NumberFormat(numberFormatToLocale(appSettings.numberFormat), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(1234.567)})`,
            })),
        },
        {
            title: t("settings.general.dateFormat"),
            value: appSettings.dateFormat,
            onValueChange: (v) => {
                const selected = DATE_FORMATS.find(
                    (format) => format.value === v,
                );
                if (selected) updateAppSettings({ dateFormat: selected.value });
            },
            options: DATE_FORMATS.map((f) => ({
                value: f.value,
                label: t(f.labelKey),
            })),
        },
    ];

    const localeRows: SelectRowConfig[] = [
        selectRow({
            title: t("settings.general.language"),
            description: t("settings.general.languageHint"),
            value: appSettings.language,
            onValueChange: (language) => updateAppSettings({ language }),
            options: [
                { value: "en", label: t("settings.general.lang.en") },
                { value: "nl", label: t("settings.general.lang.nl") },
            ],
        }),
        selectRow({
            title: t("settings.general.startOfWeek"),
            value: appSettings.startOfWeek,
            onValueChange: (startOfWeek) => updateAppSettings({ startOfWeek }),
            options: [
                { value: "monday", label: t("settings.general.monday") },
                { value: "sunday", label: t("settings.general.sunday") },
            ],
        }),
        {
            title: t("settings.general.pageSize"),
            description: t("settings.general.pageSizeHint"),
            value: String(appSettings.defaultPageSize),
            onValueChange: (v) =>
                updateAppSettings({ defaultPageSize: Number(v) }),
            options: [
                { value: "25", label: `25 ${t("settings.general.rows")}` },
                { value: "50", label: `50 ${t("settings.general.rows")}` },
                { value: "100", label: `100 ${t("settings.general.rows")}` },
                { value: "200", label: `200 ${t("settings.general.rows")}` },
            ],
        },
    ];

    return (
        <SettingsSection title={t("settings.tab.general")}>
            <SettingsGroup label={t("settings.group.formatting")}>
                {formattingRows.map((row) => (
                    <SelectSettingRow key={row.title} {...row} />
                ))}
            </SettingsGroup>

            <SettingsGroup label={t("settings.group.localeDisplay")}>
                {localeRows.map((row) => (
                    <SelectSettingRow key={row.title} {...row} />
                ))}
            </SettingsGroup>
        </SettingsSection>
    );
});
