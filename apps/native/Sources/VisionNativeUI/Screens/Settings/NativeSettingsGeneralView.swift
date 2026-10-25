import SwiftUI
import VisionNativeCore

struct NativeSettingsGeneralView: View {
    let model: NativeSettingsModel
    let shell: NativeShellModel
    private var strings: any Localizing { shell.strings }
    private let currencies = [
        "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "HRK",
        "TRY", "SAR", "AED", "INR", "BRL", "MXN", "ZAR", "SGD", "HKD", "NZD", "KRW", "THB", "MYR", "PHP",
    ]
    var body: some View {
        NativeSettingsSection(title: strings.t("settings.tab.general")) {
            NativeSettingsGroup(title: strings.t("settings.group.formatting")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.currency"),
                    description: strings.t("settings.general.currencyHint"),
                    value: string("defaultCurrency", fallback: "EUR"),
                    options: currencies.map { .init(value: $0, label: $0) })
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.numberFormat"), value: string("numberFormat", fallback: "eu"),
                    options: ["eu", "us", "ch", "in"].map {
                        .init(value: $0, label: strings.t("settings.numberFormat." + $0))
                    })
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.decimalPlaces"),
                    value: integer("showDecimalPlaces", fallback: 2),
                    options: decimalOptions)
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.dateFormat"),
                    value: string("dateFormat", fallback: "DD/MM/YYYY"),
                    options: [
                        ("DD/MM/YYYY", "ddmmyyyy"), ("MM/DD/YYYY", "mmddyyyy"), ("YYYY-MM-DD", "yyyymmdd"),
                        ("DD.MM.YYYY", "ddmmyyyy2"), ("DD-MM-YYYY", "ddmmyyyy3"),
                    ].map { .init(value: $0.0, label: strings.t("settings.dateFormat." + $0.1)) })
            }
            NativeSettingsGroup(title: strings.t("settings.group.localeDisplay")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.language"),
                    description: strings.t("settings.general.languageHint"),
                    value: string("language", fallback: "en"),
                    options: ["en", "nl"].map { .init(value: $0, label: strings.t("settings.general.lang." + $0)) })
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.startOfWeek"), value: string("startOfWeek", fallback: "monday"),
                    options: ["monday", "sunday"].map { .init(value: $0, label: strings.t("settings.general." + $0)) })
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.pageSize"),
                    description: strings.t("settings.general.pageSizeHint"),
                    value: integer("defaultPageSize", fallback: 50),
                    options: [25, 50, 100, 200].map {
                        .init(value: String($0), label: String($0) + " " + strings.t("settings.general.rows"))
                    })
            }
        }
    }
    private var decimalOptions: [NativeSettingsOption] {
        let locale =
            NumberFormat(rawValue: model.appString("numberFormat", fallback: "eu"))?.locale ?? NumberFormat.eu.locale
        return (0...3).map { digits in
            .init(
                value: String(digits),
                label: String(digits) + " ("
                    + VisionFormat.decimal(Decimal(string: "1234.567")!, fractionDigits: digits, locale: locale) + ")")
        }
    }
    private func string(_ key: String, fallback: String) -> Binding<String> {
        Binding(get: { model.appString(key, fallback: fallback) }, set: { model.updateApp([key: .string($0)]) })
    }
    private func integer(_ key: String, fallback: Int) -> Binding<String> {
        Binding(
            get: { String(model.appInt(key, fallback: fallback)) },
            set: {
                if let number = Int($0) { model.updateApp([key: .number(Decimal(number))]) }
            })
    }
}
