import SwiftUI
import VisionNativeCore

public struct NativeSettingsWindow: View {
    let model: NativeSettingsModel
    let shell: NativeShellModel
    let ai: NativeSettingsAIModel
    let backup: NativeSettingsBackupModel
    let about: NativeSettingsAboutModel
    let section: String
    let onSelectSection: (String) -> Void
    let onClose: () -> Void
    let restartOnboarding: @MainActor () async -> Void
    let resetPreferences: @MainActor () async -> Void
    @State private var selected: NativeSettingsWindowSection
    @FocusState private var focused: NativeSettingsWindowSection?
    @Environment(\.visionTheme) private var theme
    public init(
        model: NativeSettingsModel, shell: NativeShellModel,
        ai: NativeSettingsAIModel, backup: NativeSettingsBackupModel, about: NativeSettingsAboutModel,
        section: String = "general", onSelectSection: @escaping (String) -> Void, onClose: @escaping () -> Void,
        restartOnboarding: @escaping @MainActor () async -> Void,
        resetPreferences: @escaping @MainActor () async -> Void
    ) {
        self.model = model
        self.shell = shell
        self.ai = ai
        self.backup = backup
        self.about = about
        self.section = section
        self.onSelectSection = onSelectSection
        self.onClose = onClose
        self.restartOnboarding = restartOnboarding
        self.resetPreferences = resetPreferences
        _selected = State(initialValue: NativeSettingsWindowSection(rawValue: section) ?? .general)
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 4) {
                    ForEach(NativeSettingsWindowSection.allCases, id: \.rawValue) { item in
                        Button {
                            select(item)
                        } label: {
                            Label(strings.t(item.titleKey), systemImage: item.symbol).font(.body)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(
                                    .vertical, 12
                                )
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .background(
                                selected == item ? theme.primary.opacity(0.14) : Color.clear,
                                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                            )
                            .accessibilityAddTraits(selected == item ? [.isSelected] : [])
                            .focusable(selected == item)
                            .focused($focused, equals: item)
                            .onKeyPress { press in
                                let move: NativeSettingsWindowSection.Movement
                                switch press.key {
                                case .upArrow, .leftArrow: move = .previous
                                case .downArrow, .rightArrow: move = .next
                                case .home: move = .first
                                case .end: move = .last
                                default: return .ignored
                                }
                                let next = item.moving(move)
                                select(next)
                                focused = next
                                return .handled
                            }
                    }
                }.padding(.horizontal, 12).padding(.top, 24)
                Spacer()
                Text(strings.t("settings.autosaveHint")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                    .padding(18)
            }.frame(width: 225).background(theme.foreground.opacity(0.025))
                .accessibilityElement(children: .contain).accessibilityLabel(strings.t("settings.title"))
            Divider()
            VStack(spacing: 0) {
                HStack {
                    Text(strings.t(selected.titleKey)).font(Font.visionTitle3)
                        .lineLimit(1).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button(action: onClose) { Image(systemName: "xmark") }.buttonStyle(.plain)
                        .accessibilityLabel(strings.t("common.close")).keyboardShortcut(.cancelAction)
                }.padding(.horizontal, 24).frame(height: 48)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if model.isLoading && !model.isLoaded {
                            ProgressView().accessibilityLabel(strings.t("common.loading"))
                        }
                        if let error = model.loadError {
                            Text(strings.t(error)).font(.callout).foregroundStyle(theme.destructive)
                                .task(id: error) { AccessibilityNotification.Announcement(strings.t(error)).post() }
                        }
                        pane
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }.accessibilityLabel(strings.t(selected.titleKey))
            }.frame(maxWidth: .infinity)
        // The web settings dialog is `max-w-4xl` (896 px) and nearly full height.
        }.frame(minWidth: 880, idealWidth: 900, minHeight: 640, idealHeight: 760)
            .background(theme.card).foregroundStyle(theme.foreground)
            .accessibilityElement(children: .contain).accessibilityLabel(strings.t("settings.title"))
            .onChange(of: section) { _, next in selected = NativeSettingsWindowSection(rawValue: next) ?? .general }
    }
    private func select(_ item: NativeSettingsWindowSection) {
        selected = item
        onSelectSection(item.rawValue)
    }
    @ViewBuilder private var pane: some View {
        switch selected {
        case .general: NativeSettingsGeneralView(model: model, shell: shell).disabled(!model.isLoaded)
        case .appearance: NativeSettingsAppearanceView(model: model, shell: shell).disabled(!model.isLoaded)
        case .statistics: NativeSettingsInsightsView(model: model, shell: shell).disabled(!model.isLoaded)
        case .behavior: NativeSettingsBehaviorView(model: model, shell: shell).disabled(!model.isLoaded)
        case .ai: NativeSettingsAIView(model: ai, settings: model, shell: shell)
        case .backup: NativeSettingsBackupView(model: backup, shell: shell)
        case .about:
            NativeSettingsAboutView(
                model: about, shell: shell,
                adminMode: Binding(
                    get: { model.appBool("adminMode", fallback: false) },
                    set: { model.updateApp(["adminMode": .bool($0)]) }),
                preferencesLoaded: model.isLoaded, restartOnboarding: restartOnboarding,
                resetPreferences: resetPreferences)
        }
    }
}
