import SwiftUI
import VisionNativeCore

/// `PageHeader` with its icon: the page's SF Symbol in a rounded square, the title and the
/// subtitle, and the header actions on the trailing side.
struct VisionPageHeader<Actions: View>: View {
    let title: String
    let subtitle: String
    let symbol: String
    @ViewBuilder var actions: () -> Actions
    @Environment(\.visionTheme) var theme

    var body: some View {
        PageHeaderLayout {
            titleBlock
            // One subview however many actions the page passes (`gap-2`).
            HStack(spacing: 8) { actions() }
        }
    }

    private var titleBlock: some View {
        HStack(alignment: .center, spacing: 12) {
            // PageHeader's default icon: a bare 20 pt muted glyph in a 36 pt slot (its gradient
            // tile only shows when a page passes an icon colour).
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(Color(token: theme.palette.mutedForeground))
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.visionLargeTitle)
                    .visionCanvasTextHalo(.pageHeader)
                    .accessibilityAddTraits(.isHeader)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.body)
                        .foregroundStyle(theme.secondaryLabel)
                        .visionCanvasTextHalo(.pageHeader)
                }
            }
        }
    }
}

/// `PageHeader`'s `sm:flex-row sm:flex-wrap sm:justify-between sm:gap-4`: the title block (a
/// `basis-80`, 320 pt) and the actions share a row while both fit; otherwise the actions wrap
/// below the title, pushed to the trailing edge (`sm:ml-auto`), so nothing runs past the page.
struct PageHeaderLayout: Layout {
    static let titleBasis: CGFloat = 320
    static let gap: CGFloat = 16

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let plan = Self.plan(width: proposal.width, subviews: subviews)
        return CGSize(width: proposal.width ?? plan.width, height: plan.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let title = subviews.first else { return }
        let plan = Self.plan(width: bounds.width, subviews: subviews)
        title.place(
            at: CGPoint(x: bounds.minX, y: bounds.minY + (plan.rowHeight - plan.titleHeight) / 2),
            proposal: ProposedViewSize(width: plan.titleWidth, height: plan.titleHeight))
        guard subviews.count > 1 else { return }
        let actions = subviews[1]
        let size = actions.sizeThatFits(.unspecified)
        guard size.width > 0 else { return }
        let originY = plan.wraps ? bounds.minY + plan.rowHeight + Self.gap : bounds.minY + (plan.rowHeight - size.height) / 2
        actions.place(
            at: CGPoint(x: bounds.maxX - size.width, y: originY), proposal: ProposedViewSize(size))
    }

    private struct Plan {
        var width: CGFloat
        var height: CGFloat
        var rowHeight: CGFloat
        var titleWidth: CGFloat
        var titleHeight: CGFloat
        var wraps: Bool
    }

    private static func plan(width available: CGFloat?, subviews: Subviews) -> Plan {
        guard let title = subviews.first else {
            return Plan(width: 0, height: 0, rowHeight: 0, titleWidth: 0, titleHeight: 0, wraps: false)
        }
        let actionSize = subviews.count > 1 ? subviews[1].sizeThatFits(.unspecified) : .zero
        let hasActions = subviews.count > 1 && actionSize.width > 0
        let ideal = title.sizeThatFits(.unspecified)
        guard let available else {
            let width = ideal.width + (hasActions ? gap + actionSize.width : 0)
            let height = max(ideal.height, actionSize.height)
            return Plan(
                width: width, height: height, rowHeight: height, titleWidth: ideal.width, titleHeight: ideal.height,
                wraps: false)
        }
        let basis = min(titleBasis, ideal.width)
        let wraps = hasActions && basis + gap + actionSize.width > available
        let titleWidth = wraps || !hasActions ? available : available - gap - actionSize.width
        let titleHeight = title.sizeThatFits(ProposedViewSize(width: titleWidth, height: nil)).height
        let rowHeight = wraps || !hasActions ? titleHeight : max(titleHeight, actionSize.height)
        let height = wraps ? titleHeight + gap + actionSize.height : rowHeight
        return Plan(
            width: available, height: height, rowHeight: rowHeight, titleWidth: titleWidth,
            titleHeight: titleHeight, wraps: wraps)
    }
}

extension VisionPageHeader where Actions == EmptyView {
    init(title: String, subtitle: String, symbol: String) {
        self.init(title: title, subtitle: subtitle, symbol: symbol) { EmptyView() }
    }
}

/// `EmptyState` / `StateBlock`: a 40 pt rounded tile (`bg-foreground/[0.05]`) holding a 20 pt
/// icon, a title (`type-title-3`, or `type-headline` when `compact`), an optional description
/// (`type-callout`, `max-w-sm`/`max-w-xs`) and the action row. `framed` draws it on the card
/// surface, for the pages whose web `<Card>` wraps the block.
struct VisionEmptyState<Action: View>: View {
    let symbol: String
    let title: String
    var description: String?
    /// `size="compact"`: `py-6`, the headline title, `max-w-xs`, `mt-4` before the action.
    var compact = false
    /// Wrap the block in a bordered card.
    var framed = false
    @ViewBuilder var action: () -> Action
    @Environment(\.visionTheme) var theme

    var body: some View {
        if framed {
            block.visionCardBackground()
        } else {
            block
        }
    }

    private var block: some View {
        VStack(spacing: 0) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(theme.secondaryLabel)
                .frame(width: 40, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: CGFloat(DesignTokens.Radius.control), style: .continuous)
                        .fill(theme.foreground.opacity(0.05))
                )
                .padding(.bottom, 12)
                .accessibilityHidden(true)
            Text(title)
                .font(compact ? .headline : .visionTitle3)
                .foregroundStyle(theme.foreground)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if let description {
                Text(description)
                    .font(.callout)
                    .foregroundStyle(theme.secondaryLabel)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: compact ? 320 : 384)
                    .padding(.top, 4)
            }
            action()
                .padding(.top, compact ? 16 : 20)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, compact ? 24 : 44)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}
