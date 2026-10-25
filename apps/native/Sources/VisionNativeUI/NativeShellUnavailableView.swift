import AppKit
import SwiftUI
import VisionNativeCore

/// Native presentation for startup and unavailable routes.
struct NativeShellUnavailableView: View {
    let detail: NativeShellDetail
    let strings: any Localizing
    var retry: (() -> Void)?
    var reload: (@MainActor () -> Void)?
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(spacing: 16) {
            if detail == .loading {
                // Spinner and label as separate views: the label is then ordinary text, which the
                // print/PDF renderer (and its structure test) always captures.
                VStack(spacing: 8) {
                    ProgressView().accessibilityHidden(true)
                    Text(strings.t("common.loading"))
                }
                .accessibilityElement(children: .combine)
            } else {
                Text(strings.t("common.error")).font(.title3).accessibilityAddTraits(.isHeader)
                // ErrorBoundary's fallback: Retry, then Reload page.
                HStack(spacing: 8) {
                    if let retry { Button(strings.t("common.retry"), action: retry).buttonStyle(.visionPrimary) }
                    if let reload { Button(strings.t("common.reload"), action: reload).buttonStyle(.visionOutline) }
                }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(theme.foreground)
        .background(theme.background)
    }
}
