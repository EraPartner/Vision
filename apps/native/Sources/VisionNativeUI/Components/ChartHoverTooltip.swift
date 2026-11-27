import SwiftUI
import VisionNativeCore

/// One line of a chart tooltip: the series swatch, its label and its formatted value.
struct ChartTooltipItem: Identifiable, Equatable {
    let id: String
    let label: String
    let value: String
    var color: Color?
}

/// `ChartTooltip` (components/charts/ChartTooltip.tsx): the floating readout of the hovered
/// category. It sits centred above its anchor with a 12 pt gap, moves beside the anchor when it
/// would leave the chart sideways, below it when there is no visible room above, and is kept
/// inside the visible area at all four edges. Sideways the chart box bounds it; vertically the
/// visible part of the enclosing scroll view does (the web uses the viewport). `--popover` with
/// the elevation shadow; `glass-thick` under Full effects.
///
/// Place it in a chart overlay that spans `bounds`, with `anchor` in the overlay's coordinates.
struct ChartHoverTooltip: View {
    let title: String?
    let items: [ChartTooltipItem]
    let anchor: CGPoint
    /// The chart box the tooltip stays within sideways.
    let bounds: CGSize
    @State private var size: CGSize = .zero
    /// The visible part of the enclosing scroll view, in the overlay's coordinates.
    @State private var scrollVisible: CGRect?
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionFullEffects) private var fullEffects
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let gap: CGFloat = 12
    private static let pad: CGFloat = 8

    /// Without an enclosing scroll view, the room assumed above the chart.
    private static let fallbackRoomAbove: CGFloat = 160

    /// The area the tooltip stays inside: the chart's width, and the visible scroll range
    /// vertically (or the chart plus `fallbackRoomAbove` when nothing scrolls).
    static func visibleArea(bounds: CGSize, scrollVisible: CGRect?) -> CGRect {
        guard let scrollVisible, scrollVisible.height > 0 else {
            return CGRect(x: 0, y: -fallbackRoomAbove, width: bounds.width, height: bounds.height + fallbackRoomAbove)
        }
        return CGRect(x: 0, y: scrollVisible.minY, width: bounds.width, height: scrollVisible.height)
    }

    /// `computePosition`: where the tooltip's top-left corner goes for its measured size, kept
    /// `pad` inside `visible` on every edge.
    static func origin(anchor: CGPoint, size: CGSize, visible: CGRect) -> CGPoint {
        var x = anchor.x - size.width / 2
        var y = anchor.y - size.height - gap
        var side = false
        if x + size.width > visible.maxX - pad {
            side = true
            x = anchor.x - size.width - gap
            y = anchor.y - size.height / 2
        } else if x < visible.minX + pad {
            side = true
            x = anchor.x + gap
            y = anchor.y - size.height / 2
        }
        // No room above: drop below the anchor if it fits there, else pin to the top.
        if !side, y < visible.minY + pad {
            let below = anchor.y + gap
            y = below + size.height <= visible.maxY - pad ? below : visible.minY + pad
        }
        if x + size.width > visible.maxX - pad { x = max(visible.minX + pad, visible.maxX - size.width - pad) }
        if x < visible.minX + pad { x = visible.minX + pad }
        if y + size.height > visible.maxY - pad { y = max(visible.minY + pad, visible.maxY - size.height - pad) }
        if y < visible.minY + pad { y = visible.minY + pad }
        return CGPoint(x: x, y: y)
    }

    var body: some View {
        let origin = Self.origin(
            anchor: anchor, size: size, visible: Self.visibleArea(bounds: bounds, scrollVisible: scrollVisible))
        VStack(alignment: .leading, spacing: 6) {
            if let title, !title.isEmpty {
                Text(title)
                    .font(.caption2.weight(.medium))
                    .tracking(1.3)
                    .textCase(.uppercase)
                    .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items) { item in
                    HStack(spacing: 12) {
                        HStack(spacing: 8) {
                            if let color = item.color {
                                Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
                            }
                            Text(item.label).foregroundStyle(theme.foreground.opacity(0.8))
                        }
                        Spacer(minLength: 0)
                        Text(item.value).fontWeight(.medium).monospacedDigit().foregroundStyle(theme.foreground)
                    }
                    .lineLimit(1)
                }
            }
        }
        .font(.footnote)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minWidth: 140, maxWidth: 260, alignment: .leading)
        .fixedSize()
        .background(surface)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .offset(x: origin.x, y: origin.y)
        // Unmeasured, it would flash at the wrong place for a frame.
        .opacity(size == .zero ? 0 : 1)
        .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
        .onGeometryChange(for: CGRect?.self) { $0.bounds(of: .scrollView) } action: { scrollVisible = $0 }
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        // `AnimatePresence`: in from opacity 0, y + 4, scale 0.98; out to opacity 0, y + 2, over
        // `durations.fast` on out-expo (the scale is left out: it would scale the whole overlay box).
        .transition(
            reduceMotion
                ? .identity
                : .asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 4)),
                    removal: .opacity.combined(with: .offset(y: 2))
                ).animation(VisionMotion.outExpo(DesignTokens.Duration.fast)))
    }

    @ViewBuilder
    private var surface: some View {
        let radius = DesignTokens.Radius.card
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if fullEffects {
            VisionGlassSurface(material: .thick, cornerRadius: radius)
        } else {
            // `bg-popover shadow-elevation-3`: `0 4px 8px shadow/0.06` (dark 0.35) and the wide
            // ambient layer, whose negative spread SwiftUI cannot draw, at a third of its alpha.
            shape.fill(theme.popover)
                .overlay(shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
                .shadow(
                    color: Color(token: theme.palette.glassShadow, opacity: theme.isDark ? 0.35 : 0.06), radius: 4, y: 4)
                .shadow(
                    color: Color(token: theme.palette.glassShadow, opacity: theme.isDark ? 0.25 : 0.1), radius: 14, y: 12)
        }
    }
}
