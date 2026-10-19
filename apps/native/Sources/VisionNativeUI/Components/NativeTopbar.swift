import AppKit
import SwiftUI
import VisionNativeCore

/// AppLayout's topbar over native screens, drawn in the transparent titlebar strip: the
/// sidebar trigger and the search button while the sidebar is hidden (they sit right of the
/// traffic lights), and the page title once the page has scrolled past 96 pt, over a bar
/// material as a unified macOS toolbar does. It never takes clicks outside its buttons, so
/// the strip still drags the window.
struct NativeTopbar: View {
    let model: NativeShellModel
    let height: CGFloat
    let scrolled: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.visionTheme) private var theme

    /// `INLINE_TITLE_THRESHOLD` in AppLayout.
    static let titleThreshold: CGFloat = 96
    /// Room for the traffic lights when the sidebar no longer holds them.
    private static let trafficLightsWidth: CGFloat = 78

    var body: some View {
        HStack(spacing: 6) {
            if !model.isSidebarVisible {
                Button {
                    model.toggleSidebar()
                } label: {
                    Image(systemName: "sidebar.left").frame(width: 26, height: 22).contentShape(Rectangle())
                }
                .help(model.strings.t("menu.toggleSidebar"))
                .accessibilityLabel(model.strings.t("menu.toggleSidebar"))
                if model.commandPalette != nil {
                    Button {
                        model.openPalette()
                    } label: {
                        Image(systemName: "magnifyingglass").frame(width: 26, height: 22).contentShape(Rectangle())
                    }
                    .help(model.strings.t("commandPalette.openLabel"))
                    .accessibilityLabel(model.strings.t("commandPalette.openLabel"))
                }
            }
            if let title {
                Text(title)
                    .font(.visionDisplayHeadline)
                    .lineLimit(1)
                    .padding(.leading, model.isSidebarVisible ? 0 : 4)
                    .opacity(scrolled ? 1 : 0)
                    .offset(y: scrolled ? 0 : 4)
                    .allowsHitTesting(false)
                    .accessibilityHidden(!scrolled)
            }
            Spacer(minLength: 0)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .padding(.leading, model.isSidebarVisible ? 20 : Self.trafficLightsWidth)
        .padding(.trailing, 16)
        .frame(height: height)
        .frame(maxWidth: .infinity)
        // The strip drags the window like a titlebar; buttons above it take their own clicks.
        .background { WindowDragArea() }
        .background {
            // The web topbar's `bg-background/80 backdrop-blur`: the page background over a blur.
            // The glass detail tint read greener than the page beneath it.
            Rectangle().fill(.ultraThinMaterial)
                .overlay(Color(token: theme.palette.background, opacity: 0.88))
                .overlay(alignment: .bottom) {
                    Rectangle().fill(theme.border.opacity(0.6)).frame(height: 1)
                }
                .opacity(scrolled ? 1 : 0)
                .allowsHitTesting(false)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: DesignTokens.Duration.normal), value: scrolled)
    }

    private var title: String? {
        NavigationRegistry.matchItem(path: model.route.path).map { model.strings.t($0.titleKey) }
    }
}

/// Reports the vertical offset of the page-level scroll view in this view's area: the
/// widest scrolling `NSClipView` of the window that covers most of this view's width, so
/// inner tables and carousels do not count. SwiftUI scroll views are clip-view backed on
/// macOS; every screen is covered without per-screen hooks.
struct PageScrollObserver: NSViewRepresentable {
    let onChange: (CGFloat) -> Void

    func makeNSView(context: Context) -> ObserverView {
        let view = ObserverView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: ObserverView, context: Context) {
        view.onChange = onChange
    }

    final class ObserverView: NSView {
        var onChange: ((CGFloat) -> Void)?
        private var observer: NSObjectProtocol?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard window != nil else { return }
            observer = NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification, object: nil, queue: .main
            ) { [weak self] note in
                guard let clip = note.object as? NSClipView else { return }
                MainActor.assumeIsolated { self?.clipDidScroll(clip) }
            }
        }

        private func clipDidScroll(_ clip: NSClipView) {
            guard clip.window === window, let document = clip.documentView,
                document.frame.height > clip.bounds.height,
                clip.bounds.width >= bounds.width * 0.6
            else { return }
            let offset =
                document.isFlipped
                ? clip.bounds.minY + clip.contentInsets.top
                : document.frame.height - clip.bounds.maxY
            onChange?(max(0, offset))
        }
    }
}

/// A titlebar-like region: dragging moves the window and a double-click zooms or minimises
/// it per the system's "double-click a window's title bar" setting.
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ view: DragView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount == 2 {
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" {
                    window.performMiniaturize(nil)
                } else if action != "None" {
                    window.performZoom(nil)
                }
            } else {
                window.performDrag(with: event)
            }
        }
    }
}
