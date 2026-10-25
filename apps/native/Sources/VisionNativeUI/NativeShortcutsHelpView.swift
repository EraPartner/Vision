import SwiftUI
import VisionNativeCore

public struct NativeShortcutsHelpView: View {
    let shell: NativeShellModel
    let onClose: () -> Void
    @Environment(\.visionTheme) private var theme
    public init(shell: NativeShellModel, onClose: @escaping () -> Void) {
        self.shell = shell
        self.onClose = onClose
    }
    private var general: [(String, [String])] {
        [
            ("commandPalette.openLabel", ["⌘", "K"]), ("shortcuts.newTransaction", ["N"]),
            ("layout.settings", ["⌘", ","]), ("aria.toggleSidebar", ["⌘", "B"]),
            ("shortcuts.cycleSections", ["[", "]"]), ("shortcuts.undoDelete", ["⌘", "Z"]),
            ("shortcuts.tableNav", ["↑", "↓"]), ("shortcuts.tableOpen", ["↵"]),
            ("shortcuts.quickLook", ["Space"]), ("shortcuts.toastFocus", ["Alt", "T"]),
            ("shortcuts.showHelp", ["?"]), ("shortcuts.closeDialog", ["Esc"]),
        ]
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: shell.strings.t("shortcuts.title"), closeLabel: shell.strings.t("common.close"),
                onClose: onClose)
            .keyboardShortcut(.cancelAction)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(general.enumerated()), id: \.offset) { _, row in shortcut(row.0, row.1) }
                    heading("shortcuts.goTo")
                    ForEach(NavigationRegistry.allItems.filter { $0.shortcutKey != nil }) { item in
                        shortcut(item.titleKey, ["G", item.shortcutKey!.uppercased()])
                    }
                    heading("shortcuts.desktopSection")
                    shortcut("shortcuts.newTransaction", ["⌘", "N"])
                    shortcut("shortcuts.importCsv", ["⇧", "⌘", "I"])
                    shortcut("aria.toggleSidebar", ["⌃", "⌘", "S"])
                    shortcut("shortcuts.goToSection", ["⌘", "1", "–", "9"])
                    Text(shell.strings.t("shortcuts.chartScrub")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    Text(shell.strings.t("shortcuts.rowMenu")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                }.padding(.trailing, 8)
            }
        }.visionDialogPadding().frame(width: 448, height: 660).foregroundStyle(theme.foreground).background(theme.card)
    }
    private func heading(_ key: String) -> some View {
        Text(shell.strings.t(key)).font(.footnote.weight(.semibold)).foregroundStyle(theme.secondaryLabel)
            .padding(.top, 8).accessibilityAddTraits(.isHeader)
    }
    private func shortcut(_ key: String, _ keys: [String]) -> some View {
        HStack(spacing: 12) {
            Text(shell.strings.t(key)).font(.callout).foregroundStyle(theme.foreground)
            Spacer()
            HStack(spacing: 4) {
                ForEach(Array(keys.enumerated()), id: \.offset) { _, text in
                    Text(text).font(.caption.weight(.medium)).frame(minWidth: 20, minHeight: 20).padding(.horizontal, 6)
                        .background(
                            theme.foreground.opacity(0.05),
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                                .strokeBorder(theme.border.opacity(0.6)))
                }
            }.foregroundStyle(theme.secondaryLabel)
        }.accessibilityElement(children: .combine)
    }
}
