import SwiftUI
import VisionNativeCore

struct StatisticsFlowView: View {
    let flow: StatisticsFlow
    let settings: NativeAppSettings
    let currency: String
    let strings: any Localizing
    @State private var hoveredNode: String?
    private let onHoverChange: (String?, String?) -> Void
    @State private var hoveredLink: String?
    @Environment(\.visionTheme) private var theme

    init(
        flow: StatisticsFlow, settings: NativeAppSettings, currency: String, strings: any Localizing,
        initialNode: String? = nil, initialLink: String? = nil,
        onHoverChange: @escaping (String?, String?) -> Void = { _, _ in }
    ) {
        self.flow = flow
        self.settings = settings
        self.currency = currency
        self.strings = strings
        _hoveredNode = State(initialValue: initialNode)
        _hoveredLink = State(initialValue: initialLink)
        self.onHoverChange = onHoverChange
    }
    var body: some View {
        let layout = StatisticsFlowLayout(flow: flow)
        GeometryReader { geometry in
            let size = geometry.size
            Canvas { context, size in
                for link in layout.links {
                    guard let from = layout.nodes.first(where: { $0.id == link.source }),
                        let to = layout.nodes.first(where: { $0.id == link.target })
                    else { continue }
                    let active =
                        hoveredNode == nil && hoveredLink == nil || hoveredNode == link.source
                        || hoveredNode == link.target || hoveredLink == link.id
                    context.fill(
                        band(link: link, from: from, to: to, links: layout.links, size: size),
                        with: .color(color(to.node).opacity(active ? (hoveredNode == nil && hoveredLink == nil ? 0.34 : 0.6) : 0.1)))
                }
            }
            .onContinuousHover { phase in
                switch phase {
                case .ended:
                    hoveredNode = nil
                    hoveredLink = nil
                case .active(let location):
                    hoveredNode =
                        layout.nodes.first { node in
                            let bounds = rect(node, size: size)
                            let label = CGRect(
                                x: node.column == 0 ? bounds.minX - 6 - Self.labelWidth : bounds.maxX,
                                y: bounds.midY - 8, width: Self.labelWidth + 6, height: 16)
                            return bounds.union(label).contains(location)
                        }?.id
                    hoveredLink =
                        hoveredNode == nil
                        ? layout.links.first { link in
                            guard let from = layout.nodes.first(where: { $0.id == link.source }),
                                let to = layout.nodes.first(where: { $0.id == link.target })
                            else { return false }
                            return band(link: link, from: from, to: to, links: layout.links, size: size).contains(
                                location)
                        }?.id : nil
                }
            }
            let labelYs = labelPositions(layout, size: size)
            ForEach(layout.nodes) { node in
                let bounds = rect(node, size: size)
                // Labels 6 pt off the node edge, outside the flow: the first column's on its left
                // (end-anchored), every other column's on its right. Middle-column labels sit on a
                // card chip so the bands behind them stay readable. Spread apart vertically so
                // thin neighbours don't collide.
                let isRight = node.column == 0
                let isMiddle = node.column > 0 && node.column < layout.columnCount - 1
                let labelY = labelYs[node.id] ?? bounds.midY
                RoundedRectangle(cornerRadius: 3).fill(color(node.node).opacity(hoveredNode == node.id ? 1 : 0.85))
                    .frame(width: bounds.width, height: max(1, bounds.height))
                    .position(x: bounds.midX, y: bounds.midY)
                    .overlay {
                        VStack(alignment: isRight ? .trailing : .leading, spacing: 2) {
                            Text(label(node.node)).font(.system(size: 11, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .lineLimit(1).truncationMode(.tail)
                            if hoveredNode == node.id {
                                MoneyText(
                                    amount: node.node.value, currency: currency, settings: settings, signed: false,
                                    colored: false
                                ).font(.system(size: 10)).foregroundStyle(theme.mutedForeground)
                            }
                        }
                        .padding(.horizontal, isMiddle ? 6 : 0)
                        .padding(.vertical, isMiddle ? 3 : 0)
                        .background {
                            if isMiddle {
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                                    .fill(theme.card.opacity(0.92))
                            }
                        }
                        .frame(width: Self.labelWidth, alignment: isRight ? .trailing : .leading)
                        .position(
                            x: isRight
                                ? bounds.minX - 6 - Self.labelWidth / 2 : bounds.maxX + 6 + Self.labelWidth / 2,
                            y: labelY + (hoveredNode == node.id ? 7 : 0))
                    }
                    .accessibilityLabel(label(node.node))
                    .accessibilityValue(
                        MoneyText.text(node.node.value, currency: currency, settings: settings, signed: false)
                    )
                    .allowsHitTesting(false)
            }
        }.frame(minHeight: 380)
            .onChange(of: hoveredNode) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
            .onChange(of: hoveredLink) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
    }
    private static let labelWidth: CGFloat = 132
    private static let labelSpacing: CGFloat = 14

    /// Label centres per node: the node's middle, pushed apart within each column (top down,
    /// then back up from the bottom edge) so labels keep at least one line of spacing.
    private func labelPositions(_ layout: StatisticsFlowLayout, size: CGSize) -> [String: CGFloat] {
        var positions: [String: CGFloat] = [:]
        for column in Set(layout.nodes.map(\.column)) {
            let nodes = layout.nodes.filter { $0.column == column }
                .map { (id: $0.id, y: rect($0, size: size).midY) }
                .sorted { $0.y < $1.y }
            var ys = nodes.map(\.y)
            for index in ys.indices.dropFirst() where ys[index] < ys[index - 1] + Self.labelSpacing {
                ys[index] = ys[index - 1] + Self.labelSpacing
            }
            if let last = ys.indices.last, ys[last] > size.height - 6 {
                ys[last] = size.height - 6
                for index in ys.indices.reversed().dropFirst() where ys[index] > ys[index + 1] - Self.labelSpacing {
                    ys[index] = ys[index + 1] - Self.labelSpacing
                }
            }
            for (node, y) in zip(nodes, ys) { positions[node.id] = y }
        }
        return positions
    }

    private func rect(_ node: StatisticsFlowNodeLayout, size: CGSize) -> CGRect {
        let pad: CGFloat = 145
        let width: CGFloat = 16
        let plot = max(20, size.width - 2 * pad - width)
        return CGRect(
            x: pad + CGFloat(node.x) * plot, y: CGFloat(node.y) * (size.height - 24) + 12,
            width: width, height: CGFloat(node.height) * (size.height - 24))
    }
    private func band(
        link: StatisticsFlow.Link, from: StatisticsFlowNodeLayout, to: StatisticsFlowNodeLayout,
        links: [StatisticsFlow.Link], size: CGSize
    ) -> Path {
        let left = rect(from, size: size)
        let right = rect(to, size: size)
        let sourceTotal = max(from.node.value, links.filter { $0.source == link.source }.reduce(0) { $0 + $1.value })
        let targetTotal = max(to.node.value, links.filter { $0.target == link.target }.reduce(0) { $0 + $1.value })
        let preceding = links.prefix { $0.id != link.id }
        let sourceBefore = preceding.filter { $0.source == link.source }.reduce(0) { $0 + $1.value }
        let targetBefore = preceding.filter { $0.target == link.target }.reduce(0) { $0 + $1.value }
        let coordinate: (Decimal, Decimal, CGRect) -> CGFloat = { value, total, bounds in
            let ratio = total > 0 ? min(1, max(0, value / total)) : 0
            return bounds.minY + bounds.height * CGFloat(NSDecimalNumber(decimal: ratio).doubleValue)
        }
        let sourceTop = coordinate(sourceBefore, sourceTotal, left)
        let sourceBottom = coordinate(sourceBefore + link.value, sourceTotal, left)
        let targetTop = coordinate(targetBefore, targetTotal, right)
        let targetBottom = coordinate(targetBefore + link.value, targetTotal, right)
        var path = Path()
        path.move(to: CGPoint(x: left.maxX, y: sourceTop))
        let midpoint = (left.maxX + right.minX) / 2
        path.addCurve(
            to: CGPoint(x: right.minX, y: targetTop), control1: CGPoint(x: midpoint, y: sourceTop),
            control2: CGPoint(x: midpoint, y: targetTop))
        path.addLine(to: CGPoint(x: right.minX, y: targetBottom))
        path.addCurve(
            to: CGPoint(x: left.maxX, y: sourceBottom), control1: CGPoint(x: midpoint, y: targetBottom),
            control2: CGPoint(x: midpoint, y: sourceBottom))
        path.closeSubpath()
        return path
    }
    private func label(_ node: StatisticsFlow.Node) -> String {
        let keys = [
            "__income__": "income", "__spending__": "spending", "__funding_gap__": "fundingGap",
            "__uncategorised__": "uncategorised", "__other__": "other", "__savings__": "savings",
        ]
        return keys[node.id].map { strings.t("statsPage.sankey.\($0)") } ?? node.label
    }
    private func color(_ node: StatisticsFlow.Node) -> Color {
        let key = node.id.hasPrefix("cat:") ? node.label : node.id
        let root =
            key.split(separator: ":", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces)
            .uppercased() ?? ""
        var hash: Int32 = 0
        for character in root.utf16 { hash = hash &* 31 &+ Int32(character) }
        let p = theme.palette
        return Color(
            token: [p.chart1, p.chart2, p.chart3, p.chart4, p.chart5, p.chart6, p.chart7, p.chart8][
                Int(abs(Int64(hash)) % 8)])
    }
}
