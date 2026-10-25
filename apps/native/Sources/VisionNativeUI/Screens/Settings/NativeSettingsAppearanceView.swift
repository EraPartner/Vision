import SwiftUI
import VisionNativeCore

struct NativeSettingsAppearanceView: View {
    let model: NativeSettingsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var mode: String { model.themeString("mode", fallback: "dark") }
    private var capped: Bool { model.appBool("autoAdaptDisplay", fallback: true) && model.isLargeDisplay }
    private var variant: String { model.themeString("variant", fallback: "default") }
    var body: some View {
        NativeSettingsSection(title: strings.t("settings.tab.appearance")) {
            NativeSettingsGroup {
                NativeSettingsRow(
                    title: strings.t("settings.appearance.variant"),
                    description: strings.t("settings.appearance.variantHint"), stacked: true
                ) {
                    VStack(spacing: 8) {
                        ForEach(ThemeVariant.allCases, id: \.rawValue) { item in
                            variantButton(item)
                        }
                    }
                }
            }
            NativeSettingsGroup(title: strings.t("settings.group.sidebar")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.appearance.sidebar"),
                    description: strings.t("settings.appearance.sidebarHint"),
                    value: Binding(
                        get: { shell.isSidebarVisible ? "labels" : "icons" },
                        set: { shell.setSidebarVisible($0 == "labels") }),
                    options: ["labels", "icons"].map {
                        .init(value: $0, label: strings.t("settings.appearance.sidebar." + $0))
                    })
            }
            NativeSettingsGroup(title: strings.t("settings.group.colorMode")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.appearance.mode"),
                    description: strings.t("settings.appearance.modeHint"),
                    value: themeString("mode", fallback: "dark"),
                    options: ["light", "dark", "system", "schedule"].map {
                        .init(value: $0, label: strings.t("settings.appearance.modes." + $0))
                    })
                if mode == "schedule" {
                    Divider()
                    NativeSettingsRow(title: strings.t("settings.appearance.modes.schedule"), stacked: true) {
                        HStack(spacing: 16) {
                            schedule("lightFrom", title: "settings.appearance.lightFrom", fallback: "07:00")
                            schedule("darkFrom", title: "settings.appearance.darkFrom", fallback: "20:00")
                        }
                    }
                }
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.appearance.systemAccent"),
                    description: strings.t("settings.appearance.systemAccentHint")
                ) {
                    Toggle(
                        strings.t("settings.appearance.systemAccent"),
                        isOn: Binding(
                            get: { model.themeBool("systemAccent", fallback: false) },
                            set: { model.updateTheme(["systemAccent": .bool($0)]) })
                    )
                    .labelsHidden().toggleStyle(.switch)
                }
            }
            NativeSettingsGroup(title: strings.t("settings.group.visualEffects")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.appearance.visualEffects"),
                    description: strings.t("settings.appearance.visualEffectsHint"),
                    value: Binding(
                        get: { model.effectiveVisualEffects.rawValue },
                        set: { model.selectVisualEffects(VisualEffects(rawValue: $0)) }),
                    options: VisualEffects.allCases.map {
                        .init(value: $0.rawValue, label: strings.t("settings.appearance.visualEffects." + $0.rawValue))
                    })
                if capped {
                    Text(
                        strings.t(
                            model.effectiveVisualEffects == .reduced
                                ? "settings.appearance.visualEffectsAutoNote"
                                : "settings.appearance.visualEffectsOverrideNote")
                    )
                    .font(.caption).foregroundStyle(
                        model.effectiveVisualEffects == .reduced ? theme.primary : theme.warning
                    )
                    .padding(.horizontal, 16).padding(.bottom, 12)
                }
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.appearance.autoAdaptDisplay"),
                    description: strings.t("settings.appearance.autoAdaptDisplayHint")
                ) {
                    Toggle(
                        strings.t("settings.appearance.autoAdaptDisplay"),
                        isOn: Binding(
                            get: { model.appBool("autoAdaptDisplay", fallback: true) },
                            set: { model.setAutoAdaptDisplay($0) })
                    )
                    .labelsHidden().toggleStyle(.switch)
                }
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.appearance.fullEffects"),
                    description: strings.t("settings.appearance.fullEffectsHint")
                ) {
                    Toggle(
                        strings.t("settings.appearance.fullEffects"),
                        isOn: Binding(
                            get: { model.fullEffects },
                            set: { model.setFullEffects($0) })
                    )
                    .labelsHidden().toggleStyle(.switch)
                }
            }
            NativeSettingsGroup(title: strings.t("settings.group.accessibility")) {
                NativeSettingsRow(
                    title: strings.t("settings.appearance.gainLossColors"),
                    description: strings.t("settings.appearance.gainLossColorsHint")
                ) {
                    Picker(
                        strings.t("settings.appearance.gainLossColors"),
                        selection: Binding(
                            get: { model.appBool("colorblindGainLoss", fallback: false) ? "colorblind" : "classic" },
                            set: { model.updateApp(["colorblindGainLoss": .bool($0 == "colorblind")]) })
                    ) {
                        ForEach(["colorblind", "classic"], id: \.self) { skin in
                            HStack {
                                Circle().fill(
                                    Color(
                                        token: skin == "colorblind"
                                            ? theme.palette.colorblindLoss : theme.palette.destructive)
                                ).frame(width: 10, height: 10).accessibilityHidden(true)
                                Text(strings.t("settings.appearance.gainLossColors." + skin))
                            }.tag(skin)
                        }
                    }.labelsHidden()
                }
            }
        }
    }
    private func variantButton(_ item: ThemeVariant) -> some View {
        let key = item == .highContrast ? "highContrast" : item.rawValue
        let palette = DesignTokens.palette(item, shell.theme.appearance)
        return Button {
            model.updateTheme(["variant": .string(item.rawValue)])
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("settings.appearance.variants." + key)).font(.body)
                    Text(strings.t("settings.appearance.variantsDesc." + key)).font(.caption).foregroundStyle(
                        theme.secondaryLabel)
                }
                Spacer()
                HStack(spacing: 4) {
                    ForEach(
                        Array(
                            [
                                palette.background, palette.primary, palette.accent, palette.chart3, palette.chart4,
                                palette.destructive,
                            ].enumerated()), id: \.offset
                    ) { _, token in
                        Circle().fill(Color(token: token)).frame(width: 14, height: 14).overlay(
                            Circle().stroke(theme.border)
                        ).accessibilityHidden(true)
                    }
                }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    variant == item.rawValue ? theme.primary.opacity(0.08) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8).stroke(
                        variant == item.rawValue ? theme.primary.opacity(0.6) : theme.border))
        }.buttonStyle(.plain).accessibilityAddTraits(variant == item.rawValue ? [.isSelected] : [])
    }
    private func themeString(_ key: String, fallback: String) -> Binding<String> {
        Binding(get: { model.themeString(key, fallback: fallback) }, set: { model.updateTheme([key: .string($0)]) })
    }
    private func schedule(_ key: String, title: String, fallback: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(title)).font(.caption)
            NativeSettingsAppearanceTimeField(
                value: model.themeScheduleString(key, fallback: fallback), label: strings.t(title)
            ) {
                model.updateThemeSchedule([key: .string($0)])
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A time input keeps partial typing local, as HTML time inputs cannot emit malformed values.
private struct NativeSettingsAppearanceTimeField: View {
    let value: String
    let label: String
    let change: (String) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool
    var body: some View {
        TextField("HH:mm", text: $text).textFieldStyle(.vision).focused($focused).accessibilityLabel(label)
            .onAppear { text = value }
            .onChange(of: value) { _, next in if !focused { text = next } }
            .onChange(of: text) { _, next in
                if next.isEmpty || next.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil
                {
                    if next != value { change(next) }
                }
            }
            .onChange(of: focused) { _, isFocused in if !isFocused { text = value } }
    }
}
