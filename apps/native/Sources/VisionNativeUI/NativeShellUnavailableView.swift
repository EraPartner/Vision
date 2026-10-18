import AppKit
import SwiftUI
import VisionNativeCore

/// Native presentation for startup and unavailable routes; never reveals infrastructure.
struct NativeShellUnavailableView: View {
    let detail: NativeShellDetail
    let strings: any Localizing
    var retry: (() -> Void)?
    var reload: (@MainActor () -> Void)?
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(spacing: 16) {
            if detail == .loading {
                ProgressView(strings.t("common.loading"))
            } else {
                Text(strings.t("common.error")).font(.title3).accessibilityAddTraits(.isHeader)
                // ErrorBoundary's fallback: Retry, then Reload page.
                HStack(spacing: 8) {
                    if let retry { Button(strings.t("common.retry"), action: retry).buttonStyle(.borderedProminent) }
                    if let reload { Button(strings.t("common.reload"), action: reload) }
                }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(theme.foreground)
        .background(theme.background)
    }
}

/// The retained presentation keeps its previous hierarchy; native-only has no document view.
struct NativeShellWebPresentation<Content: View>: View {
    let mode: NativeShellPresentationMode
    let hidden: Bool
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        if mode == .nativeOnly {
            EmptyView()
        } else {
            content(hidden)
        }
    }
}
