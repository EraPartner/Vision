import AppKit
import SwiftUI
import VisionNativeCore

/// The bubble of a `Tooltip` (components/ui/tooltip.tsx `TooltipContent`): `rounded-control
/// glass-thick px-2.5 py-1.5 type-footnote font-medium text-popover-foreground`, entering with a
/// fade, a zoom from 95% and a 4 pt slide on `Ease.outExpo` over `Duration.fast` (none under Reduce
/// Motion). The glass is `VisionGlassSurface(.thick)`.
private struct VisionTooltipBubble: View {
    let text: Text
    let edge: Edge
    let theme: VisionTheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    /// Room around the bubble for the glass drop shadows, which the borderless panel must not clip.
    static let shadowMargin: CGFloat = 28
    /// `max-w` of a bubble before the text wraps.
    private static let maxWidth: CGFloat = 320

    var body: some View {
        text
            .font(VisionFonts.body(CGFloat(DesignTokens.Typography.footnote.size), weight: 500, relativeTo: .footnote))
            .foregroundStyle(theme.popoverForeground)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: Self.maxWidth, alignment: .leading)
            .background(VisionGlassSurface(material: .thick, cornerRadius: VisionControlMetrics.radius))
            .scaleEffect(appeared ? 1 : 0.95)
            .offset(y: appeared ? 0 : slide)
            .opacity(appeared ? 1 : 0)
            .padding(Self.shadowMargin)
            .environment(\.visionTheme, theme)
            .onAppear {
                withAnimation(
                    reduceMotion ? nil : .visionCurve(DesignTokens.Ease.outExpo, duration: DesignTokens.Duration.fast)
                ) { appeared = true }
            }
            .accessibilityHidden(true)
    }

    /// `slide-in-from-*-1`: 4 pt from the side the bubble sits on.
    private var slide: CGFloat {
        switch edge {
        case .top: return 4
        case .bottom: return -4
        default: return 0
        }
    }
}

/// One pending or shown tooltip.
private struct VisionTooltipRequest {
    let text: Text
    let locale: Locale
    let theme: VisionTheme
    let edge: Edge
    weak var anchor: NSView?
}

/// Shows tooltips in a borderless, mouse-transparent child panel of the anchor's window, with the
/// Radix Provider timing: 700 ms before the first one opens and none when another closed less than
/// 300 ms ago. Any click, key press or scroll closes it, like Radix's pointer-down and Escape.
@MainActor
final class VisionTooltipPresenter {
    static let shared = VisionTooltipPresenter()

    /// `delayDuration` of Radix `TooltipProvider`.
    private let openDelay: Duration = .milliseconds(700)
    /// `skipDelayDuration` of Radix `TooltipProvider`.
    private let skipDelay: Duration = .milliseconds(300)
    /// `sideOffset` of `TooltipContent`.
    private let sideOffset: CGFloat = 6

    private var pending: VisionTooltipRequest?
    private var owner: ObjectIdentifier?
    private var openTask: Task<Void, Never>?
    private var panel: NSPanel?
    private var monitor: Any?
    private var lastClosed: ContinuousClock.Instant?

    private init() {}

    /// The pointer entered `anchor`'s owner: open after the delay.
    fileprivate func enter(_ request: VisionTooltipRequest, owner: ObjectIdentifier) {
        leaveCurrent()
        pending = request
        self.owner = owner
        let skip = lastClosed.map { $0.duration(to: .now) < skipDelay } ?? false
        let delay = skip ? Duration.zero : openDelay
        openTask = Task { [weak self, delay] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled else { return }
            self?.presentPending()
        }
    }

    /// The pointer left (or the owner went away); a no-op when another owner's tooltip is current.
    func leave(owner: ObjectIdentifier) {
        guard self.owner == owner else { return }
        leaveCurrent()
    }

    private func leaveCurrent() {
        openTask?.cancel()
        openTask = nil
        pending = nil
        owner = nil
        dismissPanel()
    }

    private func presentPending() {
        guard let request = pending, let anchor = request.anchor, let window = anchor.window else { return }
        let hosting = NSHostingView(
            rootView: AnyView(
                VisionTooltipBubble(text: request.text, edge: request.edge, theme: request.theme)
                    .environment(\.locale, request.locale)))
        let size = hosting.fittingSize
        let anchorRect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        let screen = window.screen?.visibleFrame ?? anchorRect
        let frame = placement(size: size, anchor: anchorRect, screen: screen, edge: request.edge)

        let panel = NSPanel(
            contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: request.theme.isDark ? .darkAqua : .aqua)
        panel.contentView = hosting
        window.addChildWindow(panel, ordered: .above)
        self.panel = panel
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel]
        ) { [weak self] event in
            self?.leaveCurrent()
            return event
        }
    }

    private func dismissPanel() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        guard let panel else { return }
        self.panel = nil
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        lastClosed = .now
    }

    /// The panel frame (bubble plus shadow margin) that puts the bubble `sideOffset` away from the
    /// anchor on `edge`, centred along it, flipped to the other side and clamped onto the screen.
    private func placement(size: CGSize, anchor: CGRect, screen: CGRect, edge: Edge) -> CGRect {
        let margin = VisionTooltipBubble.shadowMargin
        let bubble = CGSize(width: size.width - 2 * margin, height: size.height - 2 * margin)
        func origin(_ edge: Edge) -> CGPoint {
            switch edge {
            case .top: return CGPoint(x: anchor.midX - bubble.width / 2, y: anchor.maxY + sideOffset)
            case .bottom:
                return CGPoint(x: anchor.midX - bubble.width / 2, y: anchor.minY - sideOffset - bubble.height)
            case .leading:
                return CGPoint(x: anchor.minX - sideOffset - bubble.width, y: anchor.midY - bubble.height / 2)
            case .trailing: return CGPoint(x: anchor.maxX + sideOffset, y: anchor.midY - bubble.height / 2)
            }
        }
        var point = origin(edge)
        let opposite: Edge
        switch edge {
        case .top: opposite = .bottom
        case .bottom: opposite = .top
        case .leading: opposite = .trailing
        case .trailing: opposite = .leading
        }
        if !screen.contains(CGRect(origin: point, size: bubble)) {
            let flipped = origin(opposite)
            if screen.contains(CGRect(origin: flipped, size: bubble)) { point = flipped }
        }
        point.x = min(max(point.x, screen.minX), max(screen.minX, screen.maxX - bubble.width))
        point.y = min(max(point.y, screen.minY), max(screen.minY, screen.maxY - bubble.height))
        return CGRect(x: point.x - margin, y: point.y - margin, width: size.width, height: size.height)
    }
}

/// Hands the modifier the `NSView` whose screen frame the tooltip anchors to.
private final class VisionTooltipAnchorBox {
    weak var view: NSView?
}

private struct VisionTooltipAnchor: NSViewRepresentable {
    let box: VisionTooltipAnchorBox

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        box.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        box.view = view
    }
}

private struct VisionTooltipModifier: ViewModifier {
    let text: Text
    let isEmpty: Bool
    let edge: Edge
    @Environment(\.visionTheme) private var theme
    @Environment(\.locale) private var locale
    @State private var anchor = VisionTooltipAnchorBox()

    func body(content: Content) -> some View {
        content
            .background(VisionTooltipAnchor(box: anchor))
            .onHover { inside in
                let owner = ObjectIdentifier(anchor)
                if inside && !isEmpty {
                    VisionTooltipPresenter.shared.enter(
                        VisionTooltipRequest(text: text, locale: locale, theme: theme, edge: edge, anchor: anchor.view),
                        owner: owner)
                } else {
                    VisionTooltipPresenter.shared.leave(owner: owner)
                }
            }
            .onDisappear { VisionTooltipPresenter.shared.leave(owner: ObjectIdentifier(anchor)) }
            // `.help` also supplied the accessibility hint, so VoiceOver keeps reading it.
            .accessibilityHint(isEmpty ? Text("") : text)
    }
}

extension View {
    /// The web `Tooltip` (components/ui/tooltip.tsx): a `glass-thick` bubble after the Radix hover
    /// delay, replacing the system yellow tooltip of `.help(_:)`. The text stays the accessibility
    /// hint, as `.help` made it. `edge` is the side of the view the bubble opens on (`side="top"`).
    func visionTooltip(_ text: LocalizedStringKey, edge: Edge = .top) -> some View {
        modifier(VisionTooltipModifier(text: Text(text), isEmpty: false, edge: edge))
    }

    /// `.visionTooltip` for a string; an empty string shows nothing, as `.help("")` did.
    func visionTooltip<S: StringProtocol>(_ text: S, edge: Edge = .top) -> some View {
        modifier(VisionTooltipModifier(text: Text(String(text)), isEmpty: text.isEmpty, edge: edge))
    }
}
