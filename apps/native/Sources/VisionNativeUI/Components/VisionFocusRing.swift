import AppKit
import SwiftUI
import VisionNativeCore

/// The web `focus-ring` utility (index.css `@utility focus-ring` and `:focus-visible`):
/// `outline: 3px solid hsl(var(--ring) / var(--focus-ring-alpha)); outline-offset: 1px`, drawn
/// outside the control and following its shape. Under Increase Contrast the outline is the opaque
/// `--ring` (`prefers-contrast: more`). Sizes come from `DesignTokens.FocusRing`; the alpha from
/// `VisionTheme.focusRingAlpha`.
///
/// The ring appears while `isActive` is true. When it is `nil` the ring follows the SwiftUI
/// `isFocused` environment of the nearest focusable ancestor, which is right for anything drawn
/// inside a `Button` label or a `ButtonStyle`/`ToggleStyle` body. Controls that own a
/// `@FocusState` pass it explicitly. The modifier also turns the system focus effect off, so the
/// web ring replaces the stock macOS one instead of doubling it.
/// True while a page or panel container holds focus itself. SwiftUI's `isFocused` is inherited
/// by every descendant of the nearest focusable ancestor, and a mouse click leaves focus on that
/// container (buttons are not focus targets without Full Keyboard Access), so without this every
/// button and menu in the container would draw its ring at once.
private struct VisionContainerOwnsFocusKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var visionContainerOwnsFocus: Bool {
        get { self[VisionContainerOwnsFocusKey.self] }
        set { self[VisionContainerOwnsFocusKey.self] = newValue }
    }
}

struct VisionFocusRingModifier<RingShape: InsettableShape>: ViewModifier {
    let isActive: Bool?
    let shape: RingShape
    @Environment(\.visionTheme) private var theme
    @Environment(\.isFocused) private var isFocused
    @Environment(\.visionContainerOwnsFocus) private var containerOwnsFocus
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .focusEffectDisabled()
            .overlay {
                if (isActive ?? (isFocused && !containerOwnsFocus)) && !theme.isPrintReport {
                    shape
                        .inset(by: -CGFloat(DesignTokens.FocusRing.offset + DesignTokens.FocusRing.width / 2))
                        .stroke(ringColor, lineWidth: CGFloat(DesignTokens.FocusRing.width))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    private var ringColor: Color {
        theme.ring.opacity(
            contrast == .increased ? DesignTokens.FocusRing.highContrastAlpha : theme.focusRingAlpha)
    }
}

extension View {
    /// The web focus ring around a rounded rectangle of `cornerRadius` (the control radius by default).
    func visionFocusRing(
        _ isFocused: Bool? = nil, cornerRadius: CGFloat = CGFloat(DesignTokens.Radius.control)
    ) -> some View {
        modifier(
            VisionFocusRingModifier(
                isActive: isFocused, shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)))
    }

    /// The web focus ring around an arbitrary shape (`Capsule()` for pills, `Circle()` for radios).
    func visionFocusRing<RingShape: InsettableShape>(_ isFocused: Bool? = nil, in shape: RingShape) -> some View {
        modifier(VisionFocusRingModifier(isActive: isFocused, shape: shape))
    }
}

/// A chart's keyboard focus ring (`CartesianChartFrame`: a click focuses the chart, but only
/// keyboard focus draws the ring, as `:focus-visible` does). Focus that arrives while a mouse
/// button is down came from a press on the plot, so it draws no ring; Tab does.
private struct ChartFocusRingModifier: ViewModifier {
    let focused: Bool
    @State private var byKeyboard = false

    func body(content: Content) -> some View {
        content
            .visionFocusRing(focused && byKeyboard)
            .onChange(of: focused, initial: true) { _, isFocused in
                byKeyboard = isFocused && NSEvent.pressedMouseButtons == 0
            }
    }
}

extension View {
    /// The quiet keyboard focus ring of a focusable chart; pointer focus stays ringless.
    func chartFocusRing(_ focused: Bool) -> some View { modifier(ChartFocusRingModifier(focused: focused)) }
}
