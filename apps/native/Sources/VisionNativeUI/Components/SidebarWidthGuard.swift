import AppKit
import SwiftUI

/// Hosted in an `NSHostingView` (not a SwiftUI scene), `NavigationSplitView` ignores its
/// sidebar column's `min`/`ideal` widths on first layout and can start far narrower, which
/// squeezes the sidebar's search field. This probe sits inside the sidebar column, finds the
/// enclosing `NSSplitView` once it has been laid out, widens the sidebar to `ideal` once per
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
    @MainActor private static func note(_ line: String) {
        trace.append(line)
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

        /// SwiftUI resets the column without a split resize notification; the probe fills the
        /// sidebar column, so its own frame change is the reliable signal.
        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            scheduleCorrection()
        }

        /// The first layout can run before the split view has sized its columns, and SwiftUI can
        /// later re-apply its own width, so this re-checks after every split resize.
        @objc private func splitViewDidResize(_ note: Notification) { scheduleCorrection() }

        private func scheduleCorrection() {
            guard window != nil, !pending, corrections < 8 else { return }
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
            let width = SidebarWidthGuard.correctedWidth(
                sidebar: before, splitView: splitWidth, minimum: minimum, ideal: ideal,
                firstLayout: !widened)
            widened = true
            if let width {
                corrections += 1
                splitView.setPosition(width, ofDividerAt: 0)
            }
            SidebarWidthGuard.note(
                "split=\(splitWidth) sidebar=\(before) target=\(width.map { "\($0)" } ?? "none") after=\(sidebar.frame.width)")
        }

        private func enclosingSplitView() -> NSSplitView? {
            var view = superview
            while let current = view {
                if let split = current as? NSSplitView, split.isVertical { return split }
                view = current.superview
            }
            return nil
        }
    }
}
