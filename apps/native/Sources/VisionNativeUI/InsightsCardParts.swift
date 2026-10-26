import SwiftUI
import VisionNativeCore

/// The Tailwind viewport breakpoints (`sm` 640, `md` 768, `lg` 1024, `xl` 1280 px) the Home and
/// Insights grids switch on. They compare against the window width, as the web compares against
/// the viewport (sidebar included), not against the page column.
enum InsightsBreakpoint {
    static let lg: CGFloat = 1024
    /// Assumed until the first measurement arrives.
    static let initialWidth: CGFloat = 1280
}

extension View {
    /// Writes the window width into `width`: the trailing edge of this view in window
    /// coordinates, which is the right edge of the detail column.
    func insightsWindowWidth(_ width: Binding<CGFloat>) -> some View {
        onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .global).maxX
        } action: { measured in
            if measured > 0 { width.wrappedValue = measured }
        }
    }
}

/// A CSS grid row of weighted columns (`lg:grid-cols-5` with `col-span-3` and `col-span-2` is
/// weights 3 and 2). A row holding any other number of views than weights shares the width
/// equally, so a lone child spans the row as `[&>*:only-child]:col-span-N` does. `stretch`
/// gives every cell the height of the tallest one, the grid's default `align-items: stretch`.
struct InsightsColumns: Layout {
    /// The cell heights of the last widths measured. `sizeThatFits` and `placeSubviews` run with
    /// the same widths in one layout pass, and measuring a cell sizes its whole subtree (charts
    /// included), so the second ask reuses the first. SwiftUI rebuilds the cache when the
    /// subviews change.
    struct Cache {
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    var weights: [CGFloat]
    var spacing: CGFloat = VisionPageLayout.spacing
    var stretch = false

    private func widths(total: CGFloat, count: Int) -> [CGFloat] {
        guard count > 0 else { return [] }
        let used = count == weights.count ? weights : Array(repeating: 1, count: count)
        let free = max(0, total - spacing * CGFloat(count - 1))
        let sum = max(used.reduce(0, +), 1)
        return used.map { free * $0 / sum }
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    private func heights(_ subviews: Subviews, widths: [CGFloat], cache: inout Cache) -> [CGFloat] {
        if cache.widths == widths, cache.heights.count == subviews.count { return cache.heights }
        let measured = subviews.enumerated().map { index, subview in
            subview.sizeThatFits(ProposedViewSize(width: widths[index], height: nil)).height
        }
        cache.widths = widths
        cache.heights = measured
        return measured
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let total = proposal.width ?? 640
        let cells = widths(total: total, count: subviews.count)
        return CGSize(width: total, height: heights(subviews, widths: cells, cache: &cache).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let cells = widths(total: bounds.width, count: subviews.count)
        let rowHeight = heights(subviews, widths: cells, cache: &cache).max() ?? 0
        var x = bounds.minX
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading,
                proposal: ProposedViewSize(width: cells[index], height: stretch ? rowHeight : nil))
            x += cells[index] + spacing
        }
    }
}

/// `ChartCard` / `CardHeader`: the title (`type-title-3`) with its description (`type-body`,
/// secondary) on the left and the controls on the right. The controls wrap under the title when
/// the card is too narrow for both, as `flex flex-wrap justify-between` does.
struct InsightsCardHeader<Actions: View>: View {
    let title: String
    var subtitle: String?
    var badge: String?
    var titleFont: Font = .visionTitle3
    @ViewBuilder var actions: () -> Actions
    @Environment(\.visionTheme) private var theme

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                titleBlock
                Spacer(minLength: 12)
                controls
            }
            VStack(alignment: .leading, spacing: 12) {
                titleBlock
                controls
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 8) { actions() }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(title).font(titleFont).accessibilityAddTraits(.isHeader)
                if let badge { VisionBadge(text: badge, tone: .secondary) }
            }
            if let subtitle {
                Text(subtitle)
                    .font(VisionControlMetrics.fieldFont)
                    .foregroundStyle(theme.secondaryLabel)
            }
        }
    }
}

/// The web `<Card>` of a chart or table section: a header, then the content, on the card
/// surface with `p-6` padding.
struct InsightsCard<Actions: View, Content: View>: View {
    let title: String
    var subtitle: String?
    var badge: String?
    /// The card fills the height of its grid cell.
    var fillsHeight = false
    let actions: () -> Actions
    let content: () -> Content

    init(
        title: String, subtitle: String? = nil, badge: String? = nil, fillsHeight: Bool = false,
        @ViewBuilder actions: @escaping () -> Actions, @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.badge = badge
        self.fillsHeight = fillsHeight
        self.actions = actions
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            InsightsCardHeader(title: title, subtitle: subtitle, badge: badge, actions: actions)
            content()
        }
        .padding(VisionPageLayout.padding)
        .frame(maxWidth: .infinity, maxHeight: fillsHeight ? CGFloat.infinity : nil, alignment: .topLeading)
        .visionCardBackground()
    }
}

extension InsightsCard where Actions == EmptyView {
    init(
        title: String, subtitle: String? = nil, badge: String? = nil, fillsHeight: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            title: title, subtitle: subtitle, badge: badge, fillsHeight: fillsHeight,
            actions: { EmptyView() }, content: content)
    }
}

/// `ExclusionToggle`: an outline `sm` button with a filter glyph, tinted with the primary colour
/// while the exclusions apply (`border-primary/25 bg-primary/5 text-primary`) and showing the
/// struck-through filter and "Exclusions off" while they are ignored. It reads as a toggle.
struct InsightsExclusionToggle: View {
    @Binding var isOn: Bool
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        let metrics = VisionControlMetrics(size: .sm)
        let shape = RoundedRectangle(cornerRadius: VisionControlMetrics.radius, style: .continuous)
        let title = strings.t(isOn ? "exclusion.filtersActive" : "exclusion.filtersIgnored")
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 8) {
                glyph
                Text(title).lineLimit(1)
            }
            .font(metrics.font)
            .foregroundStyle(isOn ? theme.primary : theme.foreground)
            .padding(.horizontal, metrics.horizontalPadding)
            .frame(height: metrics.height)
            .background(
                shape.fill(
                    isOn
                        ? theme.primary.opacity(0.05)
                        : Color(token: theme.palette.background, opacity: hovering ? 1 : 0.8))
            )
            .overlay(
                shape.strokeBorder(
                    isOn ? theme.primary.opacity(0.25) : Color(token: theme.palette.input, opacity: 0.7),
                    lineWidth: VisionControlMetrics.borderWidth)
            )
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .visionFocusRing(cornerRadius: VisionControlMetrics.radius)
        .onHover { hovering = $0 }
        .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
        .visionTooltip(strings.t(isOn ? "exclusion.tooltipActive" : "exclusion.tooltipInactive"))
        .accessibilityLabel(title)
        .accessibilityAddTraits(traits)
    }

    private var traits: AccessibilityTraits { isOn ? [.isToggle, .isSelected] : [.isToggle] }

    /// Lucide `Filter`, or `FilterX` while the exclusions are ignored.
    private var glyph: some View {
        ZStack {
            Image(systemName: "line.3.horizontal.decrease")
            if !isOn { Image(systemName: "line.diagonal") }
        }
        .font(.system(size: 13, weight: .medium))
        .accessibilityHidden(true)
    }
}

/// The web `<Toggle size="sm">` (components/ui/toggle.tsx): a borderless label button that fills
/// with `bg-primary/15`, a primary label and a hairline ring while pressed.
struct InsightsLabelToggle: View {
    let title: String
    @Binding var isOn: Bool
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: VisionControlMetrics.radius, style: .continuous)
        Button {
            isOn.toggle()
        } label: {
            Text(title)
                .font(
                    VisionFonts.body(
                        CGFloat(DesignTokens.Typography.footnote.size), weight: 500, relativeTo: .footnote)
                )
                .lineLimit(1)
                .foregroundStyle(isOn ? theme.primary : theme.secondaryLabel)
                .padding(.horizontal, 10)
                .frame(height: VisionControlMetrics.heightSm)
                .background(shape.fill(fill))
                .overlay(shape.strokeBorder(isOn ? theme.primary.opacity(0.3) : Color.clear, lineWidth: 1))
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .visionFocusRing(cornerRadius: VisionControlMetrics.radius)
        .onHover { hovering = $0 }
        .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
        .accessibilityAddTraits(traits)
    }

    private var traits: AccessibilityTraits { isOn ? [.isToggle, .isSelected] : [.isToggle] }

    private var fill: Color {
        if isOn { return theme.primary.opacity(0.15) }
        return theme.foreground.opacity(hovering ? 0.06 : 0)
    }
}

/// `List` (components/ui/list.tsx): rows on one rounded surface (`border-border/60 bg-card/70`)
/// with hairline dividers, clipped to the card radius.
struct InsightsInsetList<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(theme.card.opacity(0.7)))
            .clipShape(shape)
            .overlay(shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }
}

/// The hairline between two rows of an `InsightsInsetList` (`divide-border/50`).
struct InsightsInsetDivider: View {
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1)
    }
}
