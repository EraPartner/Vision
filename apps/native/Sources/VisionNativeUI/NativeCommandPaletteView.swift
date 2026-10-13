import SwiftUI
import VisionNativeCore

/// An overlay over the retained native route. Root owns the scrim, presentation and
/// action dispatch, so opening the palette never remounts the underlying screen.
public struct NativeCommandPaletteView: View {
    let model: NativeCommandPaletteModel
    let shell: NativeShellModel
    @State private var selectedID: String?
    @State private var selectionWasMoved = false
    @FocusState private var searchFocused: Bool
    @Environment(\.visionTheme) private var theme

    public init(model: NativeCommandPaletteModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var groups: [NativeCommandPaletteGroup] { model.groups(strings: shell.strings) }
    private var entries: [NativeCommandPaletteEntry] { groups.flatMap(\.entries) }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.secondaryLabel).accessibilityHidden(true)
                TextField(
                    shell.strings.t("commandPalette.placeholder"),
                    text: Binding(get: { model.query }, set: { model.query = $0 })
                ).textFieldStyle(.plain).font(.body).focused($searchFocused)
                    .accessibilityLabel(shell.strings.t("commandPalette.placeholder"))
                    .onKeyPress { press in
                        switch press.key {
                        case .downArrow: return move(1, modifiers: press.modifiers)
                        case .upArrow: return move(-1, modifiers: press.modifiers)
                        case .home:
                            selectionWasMoved = true
                            selectedID = entries.first?.id
                            return .handled
                        case .end:
                            selectionWasMoved = true
                            selectedID = entries.last?.id
                            return .handled
                        default:
                            guard press.modifiers.contains(.control) else { return .ignored }
                            switch press.characters.lowercased() {
                            case "n", "j": return move(1, modifiers: press.modifiers)
                            case "p", "k": return move(-1, modifiers: press.modifiers)
                            default: return .ignored
                            }
                        }
                    }
                    .onKeyPress(.return) {
                        guard let entry = entries.first(where: { $0.id == selectedID }) else { return .ignored }
                        model.activate(entry)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        model.close()
                        return .handled
                    }
                Button(shell.strings.t("common.close"), systemImage: "xmark") { model.close() }
                    .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(theme.secondaryLabel)
            }.padding(18)
            Divider().overlay(theme.border)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if entries.isEmpty {
                            Text(shell.strings.t("commandPalette.noResults"))
                                .font(.callout).foregroundStyle(theme.secondaryLabel)
                                .frame(maxWidth: .infinity).padding(32)
                        }
                        ForEach(groups) { group in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.title).font(.caption.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                                    .padding(.horizontal, 12).padding(.bottom, 4).accessibilityAddTraits(.isHeader)
                                ForEach(group.entries) { entry in
                                    entryRow(entry).id(entry.id)
                                }
                            }
                        }
                    }.padding(8)
                }.frame(maxHeight: 440)
                    .onChange(of: selectedID) { _, id in
                        if let id { proxy.scrollTo(id, anchor: .center) }
                    }
            }
        }.frame(minWidth: 460, idealWidth: 600, maxWidth: 680)
            .background(theme.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(theme.border))
            .foregroundStyle(theme.foreground)
            .shadow(color: .black.opacity(0.2), radius: 24, y: 10)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(shell.strings.t("commandPalette.openLabel"))
            .task {
                searchFocused = true
                selectionWasMoved = false
                selectedID = entries.first?.id
            }
            .onChange(of: model.query) { _, _ in
                selectionWasMoved = false
                selectedID = entries.first?.id
            }
            .onChange(of: entries.map(\.id)) { _, ids in
                if !selectionWasMoved || (selectedID.map({ !ids.contains($0) }) ?? true) { selectedID = ids.first }
            }
    }
    private func entryRow(_ entry: NativeCommandPaletteEntry) -> some View {
        Button {
            model.activate(entry)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: entry.symbol).frame(width: 20).foregroundStyle(theme.secondaryLabel)
                    .accessibilityHidden(true)
                Text(entry.title).lineLimit(1)
                if let quote = entry.quote, let name = quote.name, !name.isEmpty {
                    Text(name).font(.caption).foregroundStyle(theme.secondaryLabel).lineLimit(1)
                }
                Spacer(minLength: 8)
                if let quote = entry.quote { quoteReadout(quote) }
                if let hint = entry.hint {
                    Text(hint).font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    selectedID == entry.id ? theme.primary.opacity(0.12) : Color.clear,
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                )
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
            .onHover { hover in
                if hover {
                    selectionWasMoved = true
                    selectedID = entry.id
                }
            }
            .accessibilityAddTraits(selectedID == entry.id ? .isSelected : [])
    }
    private func quoteReadout(_ quote: ResearchQuote) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let price = quote.price {
                Text(quotePrice(price, currency: quote.currency))
            }
            if let change = quote.changePercent {
                Text(
                    (change > 0 ? "+" : "")
                        + VisionFormat.percent(change, digits: 2, locale: shell.settings.numberFormat.locale)
                ).font(.caption).foregroundStyle(change >= 0 ? theme.gain : theme.loss)
            }
        }.monospacedDigit()
    }
    private func quotePrice(_ price: Decimal, currency: String) -> String {
        guard currency.range(of: "^[A-Za-z]{3}$", options: .regularExpression) != nil else {
            // CommandPalette's fmtSafeCurrency keeps a code-bearing, ungrouped
            // toFixed(2) fallback when the shared Intl currency guard rejects it.
            let fixed = price.formatted(
                Decimal.FormatStyle(locale: Locale(identifier: "en_US"))
                    .grouping(.never).precision(.fractionLength(2)).rounded(rule: .toNearestOrAwayFromZero))
            return "\(fixed) \(currency)"
        }
        return VisionFormat.currency(
            price, code: currency, locale: shell.settings.numberFormat.locale, fractionDigits: 2)
    }
    private func move(_ delta: Int, modifiers: EventModifiers = []) -> KeyPress.Result {
        let ids = entries.map(\.id)
        guard !ids.isEmpty else { return .ignored }
        selectionWasMoved = true
        if modifiers.contains(.command) {
            selectedID = delta > 0 ? ids.last : ids.first
            return .handled
        }
        if modifiers.contains(.option),
            let currentGroup = groups.firstIndex(where: { $0.entries.contains { $0.id == selectedID } }),
            groups.indices.contains(currentGroup + delta)
        {
            selectedID = groups[currentGroup + delta].entries.first?.id
            return .handled
        }
        let current = selectedID.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
        selectedID = ids[min(max(current + delta, 0), ids.count - 1)]
        return .handled
    }
}
