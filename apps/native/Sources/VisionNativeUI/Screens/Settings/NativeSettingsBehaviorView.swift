import SwiftUI
import VisionNativeCore

public struct NativeSettingsBehaviorView: View {
    let model: NativeSettingsModel
    let shell: NativeShellModel
    public init(model: NativeSettingsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        NativeSettingsSection(title: strings.t("settings.section.behavior")) {
            NativeSettingsGroup {
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.startupSection"),
                    description: strings.t("settings.general.startupSectionHint"),
                    value: Binding(
                        get: { model.startupSection.rawValue },
                        set: { model.updateApp(["startupSection": .string($0)]) }),
                    options: [
                        .init(value: StartupSection.budgeting.rawValue, label: strings.t("nav.home")),
                        .init(value: StartupSection.portfolio.rawValue, label: strings.t("nav.portfolio")),
                        .init(value: StartupSection.research.rawValue, label: strings.t("nav.research")),
                        .init(value: StartupSection.aiChat.rawValue, label: strings.t("nav.aiChat")),
                        .init(
                            value: StartupSection.last.rawValue,
                            label: strings.t("settings.general.startupSection.last")),
                    ])
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.general.costBasisMethod"),
                    description: strings.t("settings.general.costBasisMethodHint"),
                    value: Binding(
                        get: { model.costBasisMethod.rawValue },
                        set: { value in Task { await model.setCostBasisMethod(CostBasisMethod(rawValue: value)) } }),
                    options: CostBasisMethod.allCases.map {
                        .init(
                            value: $0.rawValue,
                            label: strings.t("settings.general.costBasisMethod." + $0.rawValue))
                    })
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.general.autoClearPlanned"),
                    description: strings.t("settings.general.autoClearPlannedHint")
                ) {
                    Toggle(
                        strings.t("settings.general.autoClearPlanned"),
                        isOn: Binding(
                            get: { model.appBool("autoClearPlannedOnMatch", fallback: true) },
                            set: { model.updateApp(["autoClearPlannedOnMatch": .bool($0)]) })
                    )
                    .labelsHidden().toggleStyle(.visionSwitchLabelless)
                }
                if model.supportsServices {
                    Divider()
                    NativeSettingsRow(
                        title: strings.t("settings.general.keepServicesOnQuit"),
                        description: strings.t("settings.general.keepServicesOnQuitHint")
                    ) {
                        Toggle(
                            strings.t("settings.general.keepServicesOnQuit"),
                            isOn: Binding(
                                get: { model.keepServicesOnQuit },
                                set: { value in Task { await model.setKeepServicesOnQuit(value) } })
                        )
                        .labelsHidden().toggleStyle(.visionSwitchLabelless).disabled(model.servicesLoading || model.servicesSaving)
                    }
                }
            }
            NativeSettingsGroup(
                title: strings.t("settings.behavior.brokerageCashCategories"),
                description: strings.t("settings.behavior.brokerageCashCategoriesHint")
            ) {
                ForEach(Array(["dividend", "interest", "fee", "tax"].enumerated()), id: \.offset) { index, kind in
                    if index != 0 { Divider() }
                    let label = strings.t("settings.behavior.brokerageCashCategory." + kind)
                    NativeSettingsRow(title: label) {
                        NativeSettingsBehaviorCategoryPicker(
                            categories: model.categories, value: model.cashCategoryId(kind),
                            disabled: model.cashLoading || model.cashSaving, label: label, strings: strings
                        ) { id in Task { await model.setCashCategory(kind, id) } }
                        .frame(maxWidth: 280)
                    }
                }
            }
            NativeSettingsGroup {
                NativeSettingsRow(
                    title: strings.t("settings.app.recurringDismissalsReset"),
                    description: strings.t("settings.app.recurringDismissalsResetHint")
                ) {
                    Button(strings.t("settings.app.reset")) { Task { await model.resetRecurringDismissals() } }
                        .buttonStyle(.visionOutline)
                }
            }
        }
    }
}
