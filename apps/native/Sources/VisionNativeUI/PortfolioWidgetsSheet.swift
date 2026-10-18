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
        VStack(alignment: .leading, spacing: 18) {
            Text(strings.t("widgets.title")).font(.title2.weight(.semibold))
            Text(strings.t("widgets.description")).foregroundStyle(theme.secondaryLabel)
            if let error {
                Text(error).foregroundStyle(theme.destructive)
                if !isLoaded { Button(strings.t("common.retry")) { Task { await reload() } } }
            }
            if !isLoaded && error == nil { ProgressView().frame(maxWidth: .infinity) }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(definitions) { widget in
                        Toggle(
                            strings.t(widget.labelKey),
                            isOn: Binding(
                                get: { visible(widget.id) },
                                set: { value in Task { await setVisible(widget.id, value) } }))
                    }
                }
            }
            .disabled(!isLoaded || isSaving)
            HStack {
                Group {
                    Button(strings.t("widgets.showAll")) { Task { await setAll(true) } }
                    Button(strings.t("widgets.hideAll")) { Task { await setAll(false) } }
                    Button(strings.t("widgets.reset")) { Task { await reset() } }
                }.disabled(!isLoaded || isSaving)
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                Button(strings.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .buttonStyle(.bordered)
        }.padding(24).frame(width: 580, height: 540)
    }
}
