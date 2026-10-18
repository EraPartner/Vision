import AppKit
import SwiftUI

/// Hosted in an `NSHostingView` (not a SwiftUI scene), `NavigationSplitView` ignores its
/// sidebar column's `min`/`ideal` widths on first layout and can start far narrower, which
/// squeezes the sidebar's search field. This probe sits inside the sidebar column, finds the
/// enclosing `NSSplitView` once it has been laid out, and widens the sidebar to `ideal` a
/// single time per launch; later drags by the user are left alone.
struct SidebarWidthGuard: NSViewRepresentable {
    /// The sidebar column's widths (AppSidebar's 248 pt default).
    static let minimumWidth: CGFloat = 200
    static let idealWidth: CGFloat = 248
    static let maximumWidth: CGFloat = 340

    let minimum: CGFloat
    let ideal: CGFloat

    func makeNSView(context: Context) -> ProbeView { ProbeView(minimum: minimum, ideal: ideal) }
    func updateNSView(_ view: ProbeView, context: Context) {}

    /// The width to move the divider to, or `nil` when the sidebar is already wide enough or
    /// the split view is too narrow to hold the ideal sidebar next to a usable detail column.
    nonisolated static func correctedWidth(
        sidebar: CGFloat, splitView: CGFloat, minimum: CGFloat, ideal: CGFloat
    ) -> CGFloat? {
        guard sidebar > 0, sidebar < ideal, splitView >= ideal * 2 else { return nil }
        return max(minimum, ideal)
    }

    final class ProbeView: NSView {
        private let minimum: CGFloat
        private let ideal: CGFloat
        private var applied = false

        init(minimum: CGFloat, ideal: CGFloat) {
            self.minimum = minimum
            self.ideal = ideal
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func layout() {
            super.layout()
            guard !applied, window != nil else { return }
            // Moving the divider inside this layout pass would re-enter it.
            Task { @MainActor [weak self] in self?.widenIfNeeded() }
        }

        private func widenIfNeeded() {
            guard !applied, let splitView = enclosingSplitView(), let sidebar = splitView.arrangedSubviews.first
            else { return }
            let splitWidth = splitView.bounds.width
            guard splitWidth > 0, sidebar.frame.width > 0 else { return }
            applied = true
            if let item = (splitView.delegate as? NSSplitViewController)?.splitViewItems.first {
                item.minimumThickness = minimum
            }
            if let width = SidebarWidthGuard.correctedWidth(
                sidebar: sidebar.frame.width, splitView: splitWidth, minimum: minimum, ideal: ideal)
            {
                splitView.setPosition(width, ofDividerAt: 0)
            }
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
