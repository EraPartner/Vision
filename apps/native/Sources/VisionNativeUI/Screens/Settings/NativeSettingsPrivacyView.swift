import SwiftUI
import VisionNativeCore

/// Settings › Privacy (ADR-271): offline mode, the data-source switches, the automatic price
/// refresh, the update check and AI on this Mac only. Every field lives in `app_settings`; the
/// Bun backend (`lib/networkPolicy.ts`), the Swift backend (`NetworkPolicyFetcher`) and the shell
/// (`NetworkAccess`) read them. Swift app only: the Electron app has no pane for them.
public struct NativeSettingsPrivacyView: View {
    let model: NativeSettingsModel
    let shell: NativeShellModel
    public init(model: NativeSettingsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var offline: Bool { model.appBool("offlineMode", fallback: false) }

    public var body: some View {
        NativeSettingsSection(title: strings.t("settings.section.privacy")) {
            NativeSettingsGroup {
                toggleRow(
                    "offlineMode", fallback: false, title: strings.t("settings.privacy.offlineMode"),
                    description: strings.t("settings.privacy.offlineModeHint"))
            }
            NativeSettingsGroup(
                title: strings.t("settings.privacy.sources"), description: strings.t("settings.privacy.sourcesHint")
            ) {
                toggleRow(
                    NetworkPolicy.Source.marketData.settingsField, fallback: true,
                    title: strings.t("settings.privacy.marketData"),
                    description: strings.t("settings.privacy.marketDataHint"))
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.privacy.priceRefresh"),
                    description: strings.t("settings.privacy.priceRefreshHint"),
                    value: Binding(
                        get: { model.appString("priceRefresh", fallback: PriceRefresh.hourly.rawValue) },
                        set: { model.updateApp(["priceRefresh": .string($0)]) }),
                    options: [
                        .init(
                            value: PriceRefresh.hourly.rawValue,
                            label: strings.t("settings.privacy.priceRefresh.hourly")),
                        .init(
                            value: PriceRefresh.daily.rawValue,
                            label: strings.t("settings.privacy.priceRefresh.daily")),
                        .init(
                            value: PriceRefresh.manual.rawValue,
                            label: strings.t("settings.privacy.priceRefresh.manual")),
                    ]
                ).disabled(offline || !model.appBool(NetworkPolicy.Source.marketData.settingsField, fallback: true))
                Divider()
                toggleRow(
                    NetworkPolicy.Source.exchangeRates.settingsField, fallback: true,
                    title: strings.t("settings.privacy.exchangeRates"),
                    description: strings.t("settings.privacy.exchangeRatesHint"))
                Divider()
                toggleRow(
                    NetworkPolicy.Source.inflation.settingsField, fallback: true,
                    title: strings.t("settings.privacy.inflation"),
                    description: strings.t("settings.privacy.inflationHint"))
            }.disabled(offline)
            NativeSettingsGroup(title: strings.t("settings.privacy.updates")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.privacy.updateCheck"),
                    description: strings.t("settings.privacy.updateCheckHint"),
                    value: Binding(
                        get: { model.appString("updateCheck", fallback: UpdateCheck.daily.rawValue) },
                        set: { model.updateApp(["updateCheck": .string($0)]) }),
                    options: [
                        .init(
                            value: UpdateCheck.daily.rawValue, label: strings.t("settings.privacy.updateCheck.daily")),
                        .init(
                            value: UpdateCheck.manual.rawValue,
                            label: strings.t("settings.privacy.updateCheck.manual")),
                    ])
            }.disabled(offline)
            NativeSettingsGroup(title: strings.t("settings.section.ai")) {
                toggleRow(
                    "aiLocalOnly", fallback: false, title: strings.t("settings.privacy.aiLocalOnly"),
                    description: strings.t("settings.privacy.aiLocalOnlyHint"))
            }
        }
    }

    private func toggleRow(_ key: String, fallback: Bool, title: String, description: String) -> some View {
        NativeSettingsRow(title: title, description: description) {
            Toggle(
                title,
                isOn: Binding(
                    get: { model.appBool(key, fallback: fallback) },
                    set: { model.updateApp([key: .bool($0)]) })
            )
            .labelsHidden().toggleStyle(.visionSwitchLabelless)
        }
    }
}
