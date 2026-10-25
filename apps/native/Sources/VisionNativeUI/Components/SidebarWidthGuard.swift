import AppKit
import SwiftUI

/// Hosted in an `NSHostingView` (not a SwiftUI scene), `NavigationSplitView` ignores its
/// sidebar column's `min`/`ideal` widths on first layout and can start far narrower, which
/// squeezes the sidebar's search field. This probe sits beside the split view, finds the
/// `NSSplitView` once it has been laid out, widens the sidebar to `ideal` once per
/// launch and afterwards only keeps it from falling below `minimum`.
struct SidebarWidthGuard: NSViewRepresentable {
    /// The sidebar column's widths (AppSidebar's 248 pt default).
    static let minimumWidth: CGFloat = 200
    static let idealWidth: CGFloat = 248
    static let maximumWidth: CGFloat = 340

    let minimum: CGFloat
    let ideal: CGFloat

    /// The last corrections the probe attempted, newest last, for test diagnostics.
    @MainActor static var trace: [String] = []
    @MainActor private static let traceStart = ContinuousClock.now
    @MainActor private static func note(_ line: String) {
        let elapsed = traceStart.duration(to: .now).components
        let ms = elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000
        trace.append("+\(ms)ms \(line)")
        if trace.count > 20 { trace.removeFirst(trace.count - 20) }
    }

    func makeNSView(context: Context) -> ProbeView { ProbeView(minimum: minimum, ideal: ideal) }
    func updateNSView(_ view: ProbeView, context: Context) {}

    /// The width to move the divider to, or `nil` to leave it. On the first measured layout a
    /// sidebar narrower than `ideal` widens to `ideal`. Afterwards only a sidebar below `minimum`
    /// moves, back to `ideal`: the user cannot drag below `minimum`, so that is SwiftUI
    /// re-applying its own 140 pt column default (it ignores `navigationSplitViewColumnWidth`
    /// here). Nothing moves while the split view is too narrow to hold the ideal sidebar next to
    /// a usable detail column.
    nonisolated static func correctedWidth(
        sidebar: CGFloat, splitView: CGFloat, minimum: CGFloat, ideal: CGFloat, firstLayout: Bool = true
    ) -> CGFloat? {
        guard sidebar > 0, splitView >= ideal * 2 else { return nil }
        if firstLayout { return sidebar < ideal ? max(minimum, ideal) : nil }
        return sidebar < minimum ? max(minimum, ideal) : nil
    }

    final class ProbeView: NSView {
        private let minimum: CGFloat
        private let ideal: CGFloat
        private var widened = false
        private var pending = false
        /// Bounds the corrections per launch, so a split view that keeps undoing them cannot
        /// make the probe fight it forever.
        private var corrections = 0
        private weak var observedSplitView: NSSplitView?
        private weak var observedSidebar: NSView?
        /// A too-narrow width seen after the first layout, and when it was first seen. A sidebar
        /// that is being shown or hidden passes through every width below `minimum`; moving the
        /// divider then fights the animation (and spends the bounded corrections), so only a width
        /// that stays put for `settleDelay` is treated as SwiftUI's own column default.
        private var narrowWidth: (width: CGFloat, since: ContinuousClock.Instant)?
        private var settleCheckPending = false
        private static let settleDelay: Duration = .milliseconds(350)

        init(minimum: CGFloat, ideal: CGFloat) {
            self.minimum = minimum
            self.ideal = ideal
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            scheduleCorrection()
        }

        override func layout() {
            super.layout()
            scheduleCorrection()
        }

        /// The probe's own frame changes with the window's layout, a cheap extra signal.
        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            scheduleCorrection()
        }

        /// The first layout can run before the split view has sized its columns, and SwiftUI can
        /// later re-apply its own width, so this re-checks after every split resize.
        @objc private func splitViewDidResize(_ note: Notification) { scheduleCorrection() }

        /// On macOS 26 SwiftUI can put its own column width back on the sidebar's item view
        /// without resizing the probe or posting a split resize, so the column's frame is watched too.
        @objc private func sidebarFrameDidChange(_ note: Notification) { scheduleCorrection() }

        private func scheduleCorrection() {
            guard window != nil, !pending, corrections < 8 else {
                if corrections >= 8 || window == nil {
                    SidebarWidthGuard.note("skip window=\(window != nil) corrections=\(corrections)")
                }
                return
            }
            pending = true
            // Moving the divider inside a layout pass would re-enter it.
            Task { @MainActor [weak self] in
                self?.pending = false
                self?.correctIfNeeded()
            }
        }

        private func correctIfNeeded() {
            guard let splitView = enclosingSplitView(), let sidebar = splitView.arrangedSubviews.first
            else {
                SidebarWidthGuard.note("no split view (window=\(window != nil))")
                return
            }
            if observedSplitView !== splitView {
                if let previous = observedSplitView {
                    NotificationCenter.default.removeObserver(
                        self, name: NSSplitView.didResizeSubviewsNotification, object: previous)
                }
                observedSplitView = splitView
                NotificationCenter.default.addObserver(
                    self, selector: #selector(splitViewDidResize(_:)),
                    name: NSSplitView.didResizeSubviewsNotification, object: splitView)
            }
            if observedSidebar !== sidebar {
                if let previous = observedSidebar {
                    NotificationCenter.default.removeObserver(
                        self, name: NSView.frameDidChangeNotification, object: previous)
                }
                observedSidebar = sidebar
                sidebar.postsFrameChangedNotifications = true
                NotificationCenter.default.addObserver(
                    self, selector: #selector(sidebarFrameDidChange(_:)),
                    name: NSView.frameDidChangeNotification, object: sidebar)
            }
            // SwiftUI rewrites the item's minimum on its own update passes, so restate it each time.
            if let item = (splitView.delegate as? NSSplitViewController)?.splitViewItems.first,
                item.minimumThickness < minimum
            {
                item.minimumThickness = minimum
            }
            let splitWidth = splitView.bounds.width
            guard splitWidth > 0, sidebar.frame.width > 0 else {
                SidebarWidthGuard.note("unsized split=\(splitWidth) sidebar=\(sidebar.frame.width)")
                return
            }
            let before = sidebar.frame.width
            let firstLayout = !widened
            let width = SidebarWidthGuard.correctedWidth(
                sidebar: before, splitView: splitWidth, minimum: minimum, ideal: ideal,
                firstLayout: firstLayout)
            widened = true
            if width != nil, !firstLayout, !hasSettled(at: before) {
                SidebarWidthGuard.note("settling sidebar=\(before)")
                return
            }
            narrowWidth = nil
            if let width {
                corrections += 1
                splitView.setPosition(width, ofDividerAt: 0)
                // SwiftUI can put its own column width back on a later pass without resizing
                // the probe, posting a split resize or a frame change (seen on macOS 26 about
                // 0.1-0.5 s after the first correction), so check again a few times after it.
                Task { @MainActor [weak self] in
                    for delay in [50, 300, 900] {
                        try? await Task.sleep(for: .milliseconds(delay))
                        self?.scheduleCorrection()
                    }
                }
            }
            SidebarWidthGuard.note(
                "split=\(splitWidth) sidebar=\(before) target=\(width.map { "\($0)" } ?? "none") after=\(sidebar.frame.width)")
        }

        /// Whether `width` has held since it was first seen at least `settleDelay` ago; otherwise
        /// records it and re-checks once the delay has passed.
        private func hasSettled(at width: CGFloat) -> Bool {
            let now = ContinuousClock.now
            if let narrowWidth, narrowWidth.width == width,
                narrowWidth.since.duration(to: now) >= Self.settleDelay
            {
                return true
            }
            if narrowWidth?.width != width { narrowWidth = (width, now) }
            if !settleCheckPending {
                settleCheckPending = true
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: Self.settleDelay + .milliseconds(30))
                    self?.settleCheckPending = false
                    self?.scheduleCorrection()
                }
            }
            return false
        }

        /// The enclosing vertical split view, or, for a probe hosted beside the split view, the
        /// window's `NavigationSplitView` split view.
        private func enclosingSplitView() -> NSSplitView? {
            var view = superview
            while let current = view {
                if let split = current as? NSSplitView, split.isVertical { return split }
                view = current.superview
            }
            return window?.contentView.flatMap(Self.navigationSplitView(in:))
        }

        private static func navigationSplitView(in view: NSView) -> NSSplitView? {
            if let split = view as? NSSplitView, split.isVertical, split.delegate is NSSplitViewController {
                return split
            }
            for child in view.subviews {
                if let split = navigationSplitView(in: child) { return split }
            }
            return nil
        }
    }
}
