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

/// The retained presentation keeps its previous hierarchy. A helper is instead mounted
/// inside an AppKit-hidden enclosure: visibility does not depend on the SDK honoring hidden.
struct NativeShellWebPresentation<Content: View>: View {
    let mode: NativeShellPresentationMode
    let hidden: Bool
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        if mode == .nativeOnly {
            EmptyView()
        } else if mode == .helperDocument {
            NativeHiddenHelperDocument(content: content(true))
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        } else {
            content(hidden)
        }
    }
}

private struct NativeHiddenHelperDocument<Content: View>: NSViewRepresentable {
    let content: Content

    func makeNSView(context: Context) -> NativeHiddenHelperContainer<Content> {
        NativeHiddenHelperContainer(content: content)
    }

    func updateNSView(_ view: NativeHiddenHelperContainer<Content>, context: Context) {
        view.host.rootView = content
        view.isHidden = true
    }
}

private final class NativeHiddenHelperContainer<Content: View>: NSView {
    let host: NSHostingView<Content>

    init(content: Content) {
        host = NSHostingView(rootView: content)
        super.init(frame: .zero)
        isHidden = true
        setAccessibilityElement(false)
        host.frame = NSRect(x: 0, y: 0, width: 1, height: 1)
        addSubview(host)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func accessibilityChildren() -> [Any]? { [] }
}
