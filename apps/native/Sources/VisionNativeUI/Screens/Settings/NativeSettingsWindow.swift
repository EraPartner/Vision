import SwiftUI
import VisionNativeCore

/// `DashboardSettingsDialog` (features/settings/DashboardSettingsDialog.tsx) as the content of an
/// in-window glass dialog: `flex h-[82vh] w-full max-w-4xl p-0 gap-0`, a `md:w-64` rail on
/// `bg-foreground/[0.025]`, a `h-12` pane header, and `px-6 py-6` body. The panel (glass, corners,
/// scrim) comes from `VisionGlassDialog`; this view fills it.
public struct NativeSettingsWindow: View {
    /// Geometry and alphas of DashboardSettingsDialog.tsx; none has a design token.
    enum Layout {
        /// `max-w-4xl`.
        static let maxWidth: CGFloat = 896
        /// `h-[82vh]`.
        static let heightFraction = 0.82
        /// `md:w-64` on the `aside`.
        static let railWidth: CGFloat = 256
        /// `md:pt-10` on the section list.
        static let railTopInset: CGFloat = 40
        /// `aria-selected:bg-primary/10`.
        static let selectedAlpha = 0.10
        /// `aria-selected:hover:bg-primary/15`.
        static let selectedHoverAlpha = 0.15
        /// `border-border/60` on the aside and the header.
        static let borderAlpha = 0.6
        /// `h-12` on the header.
        static let headerHeight: CGFloat = 48
    }

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
                            NativeSettingsRailRow(
                                title: strings.t(item.titleKey), symbol: item.symbol, isSelected: selected == item)
                        }.buttonStyle(.plain)
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
                }.padding(.horizontal, 12).padding(.top, Layout.railTopInset)
                Spacer()
                Text(strings.t("settings.autosaveHint")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                    .padding(18)
            }.frame(width: Layout.railWidth).background(theme.foreground.opacity(0.025))
                .accessibilityElement(children: .contain).accessibilityLabel(strings.t("settings.title"))
            NativeSettingsHairline(vertical: true)
            VStack(spacing: 0) {
                HStack {
                    Text(strings.t(selected.titleKey)).font(Font.visionTitle3)
                        .lineLimit(1).accessibilityAddTraits(.isHeader)
                    Spacer()
                    // The web DialogContent close control, shared with every native dialog.
                    VisionDialogCloseButton(label: strings.t("common.close"), action: onClose)
                        .keyboardShortcut(.cancelAction)
                }.padding(.horizontal, DesignTokens.Overlay.dialogPadding)
                    .frame(height: Layout.headerHeight)
                NativeSettingsHairline(vertical: false)
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
                    }.padding(DesignTokens.Overlay.dialogPadding).frame(maxWidth: .infinity, alignment: .leading)
                }.accessibilityLabel(strings.t(selected.titleKey))
            }.frame(maxWidth: .infinity)
        // The glass dialog supplies the panel (`max-w-4xl`, `h-[82vh]`) and its material.
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(theme.foreground)
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
