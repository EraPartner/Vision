import SwiftUI
import VisionNativeCore

struct PortfolioWidgetsSheet: View {
    let definitions: [InsightWidget]
    let visible: @MainActor (String) -> Bool
    let setVisible: @MainActor (String, Bool) async -> Void
    let setAll: @MainActor (Bool) async -> Void
    let reset: @MainActor () async -> Void
    let reload: @MainActor () async -> Void
    let isLoaded: Bool
    let isSaving: Bool
    let error: String?
    let strings: any Localizing
    @Environment(\.dismiss) private var dismiss
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: strings.t("widgets.title"), description: strings.t("widgets.description"),
                closeLabel: strings.t("common.close"), onClose: { dismiss() }
            )
            .keyboardShortcut(.cancelAction)
            if let error {
                Text(error).foregroundStyle(theme.destructive)
                if !isLoaded { Button(strings.t("common.retry")) { Task { await reload() } }.buttonStyle(.visionOutline) }
            }
            if !isLoaded && error == nil { ProgressView().frame(maxWidth: .infinity) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(definitions) { widget in
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(strings.t(widget.labelKey)).foregroundStyle(theme.foreground)
                                if let key = widget.descriptionKey {
                                    Text(strings.t(key)).font(.footnote).foregroundStyle(theme.secondaryLabel)
                                }
                            }
                            Spacer(minLength: 8)
                            Toggle(
                                strings.t(widget.labelKey),
                                isOn: Binding(
                                    get: { visible(widget.id) },
                                    set: { value in Task { await setVisible(widget.id, value) } })
                            ).labelsHidden().toggleStyle(.switch).controlSize(.small)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        if widget.id != definitions.last?.id { Divider().padding(.leading, 16) }
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous).fill(theme.card))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
            }
            .disabled(!isLoaded || isSaving)
            HStack(spacing: 8) {
                Group {
                    Button(strings.t("widgets.showAll")) { Task { await setAll(true) } }
                    Button(strings.t("widgets.hideAll")) { Task { await setAll(false) } }
                }.disabled(!isLoaded || isSaving)
                Spacer(minLength: 0)
                if isSaving { ProgressView().controlSize(.small) }
                Button(strings.t("widgets.reset"), systemImage: "arrow.counterclockwise") { Task { await reset() } }
                    .disabled(!isLoaded || isSaving)
            }
            .buttonStyle(.visionOutline)
        }.visionDialogPadding().frame(width: 448, height: 540)
    }
}
