import AppKit
import SwiftUI
import VisionNativeCore

/// AppLayout's topbar over native screens, drawn in the transparent titlebar strip: the
/// page header's title once the page has scrolled past 96 pt, and the bar veil
/// once it has scrolled past 8 pt. The web's search button is `md:hidden` (phones only); the
/// sidebar and its icon rail keep the search entry. It never takes clicks outside its buttons,
/// so the strip still drags the window.
struct NativeTopbar: View {
    let model: NativeShellModel
    let height: CGFloat
    /// `scrolled` (`scrollY > 8`): the veil and its hairline show.
    let veiled: Bool
    /// `titleVisible` (`scrollY > 96`): the inline page title shows.
    let scrolled: Bool
    /// The page header's title (`usePageTitle`); the sidebar item's title when the page has none.
    var pageTitle: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.visionTheme) private var theme

    /// AppLayout's topbar `h-14`: the page content starts below it.
    static let barHeight: CGFloat = 56
    /// `INLINE_TITLE_THRESHOLD` in AppLayout.
    static let titleThreshold: CGFloat = 96
    /// AppLayout's `setScrolled(window.scrollY > 8)`.
    static let veilThreshold: CGFloat = 8
    /// Room for the traffic lights when the sidebar no longer holds them: the icon rail
    /// under them already takes its own width of it.
    /// The traffic lights end about 74 pt in (`trafficLightPosition` x 20); the trigger keeps a
    /// 12 pt gap after them.
    private static let trafficLightsWidth: CGFloat = 86 - NativeSidebarRail.width

    var body: some View {
        HStack(spacing: 0) {
            // No SidebarTrigger here (Tor, 2026-11-14): beside the sidebar header's own collapse
            // button it was a second sidebar icon. The sidebar's collapse button, the icon
            // rail's toggle, ⌃⌘S and View › Toggle Sidebar keep every way to open and close it.
            if let title {
                Text(title)
                    .font(.visionDisplayHeadline)
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .opacity(scrolled ? 1 : 0)
                    .offset(y: scrolled ? 0 : 4)
                    .allowsHitTesting(false)
                    .accessibilityHidden(!scrolled)
            }
            Spacer(minLength: 0)
        }
        // `px-4`.
        .padding(.leading, model.isSidebarVisible ? 16 : Self.trafficLightsWidth)
        .padding(.trailing, 16)
        .frame(height: height)
        .frame(maxWidth: .infinity)
        // The strip drags the window like a titlebar; buttons above it take their own clicks.
        .background { WindowDragArea() }
        .background {
            // `.app-topbar::before` (index.css): a `--background` gradient (0.82 → 0.68 light,
            // 0.7 → 0.56 dark) over a 16 px backdrop blur, the bottom border (`--border` at 0.5 /
            // 0.7), the inset glass highlight and a soft drop shadow; hidden at scroll-top.
            Rectangle().fill(.ultraThinMaterial)
                .overlay(
                    LinearGradient(
                        colors: [
                            Color(token: theme.palette.background, opacity: theme.isDark ? 0.7 : 0.82),
                            Color(token: theme.palette.background, opacity: theme.isDark ? 0.56 : 0.68),
                        ], startPoint: .top, endPoint: .bottom)
                )
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(Color(token: theme.palette.glassHighlight, opacity: theme.isDark ? 0.06 : 0.3))
                        .frame(height: 1)
                }
                .overlay(alignment: .bottom) {
                    Rectangle().fill(theme.border.opacity(theme.isDark ? 0.7 : 0.5)).frame(height: 1)
                }
                .shadow(
                    color: Color(token: theme.palette.glassShadow, opacity: theme.isDark ? 0.38 : 0.05),
                    radius: theme.isDark ? 16 : 14, y: theme.isDark ? 14 : 12)
                .opacity(veiled ? 1 : 0)
                .allowsHitTesting(false)
        }
        // `<BackgroundQueryIndicator />` is the header's last child, `absolute inset-x-0 bottom-0`:
        // the 2 pt line runs along the bar's bottom edge, not the window's top edge.
        .overlay(alignment: .bottom) {
            if let inspector = model.apiInspector { BackgroundQueryIndicator(inspector: inspector) }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: DesignTokens.Duration.normal), value: scrolled)
        // `transition: opacity var(--duration-normal) var(--ease-glide)`.
        .animation(
            reduceMotion ? nil : .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.normal),
            value: veiled)
    }

    private var title: String? {
        if let pageTitle, !pageTitle.isEmpty { return pageTitle }
        return NavigationRegistry.matchItem(path: model.route.path).map { model.strings.t($0.titleKey) }
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
