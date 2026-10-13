import SwiftUI
import VisionNativeCore

/// An overlay over the retained native route. Root owns the scrim, presentation and
/// action dispatch, so opening the palette never remounts the underlying screen.
public struct NativeCommandPaletteView: View {
    let model: NativeCommandPaletteModel
    let shell: NativeShellModel
    @State private var selectedID: String?
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
                    .onKeyPress(.downArrow) { move(1) }
                    .onKeyPress(.upArrow) { move(-1) }
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
                selectedID = entries.first?.id
            }
            .onChange(of: model.query) { _, _ in selectedID = entries.first?.id }
            .onChange(of: entries.map(\.id)) { _, ids in
                if selectedID.map({ !ids.contains($0) }) ?? true { selectedID = ids.first }
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
            .onHover { hover in if hover { selectedID = entry.id } }
            .accessibilityAddTraits(selectedID == entry.id ? .isSelected : [])
    }
    private func quoteReadout(_ quote: ResearchQuote) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let price = quote.price {
                Text(
                    VisionFormat.currency(
                        price, code: quote.currency, locale: shell.settings.numberFormat.locale, fractionDigits: 2))
            }
            if let change = quote.changePercent {
                Text(
                    (change > 0 ? "+" : "")
                        + VisionFormat.percent(change, digits: 2, locale: shell.settings.numberFormat.locale)
                ).font(.caption).foregroundStyle(change >= 0 ? theme.gain : theme.loss)
            }
        }.monospacedDigit()
    }
    private func move(_ delta: Int) -> KeyPress.Result {
        let ids = entries.map(\.id)
        guard !ids.isEmpty else { return .ignored }
        let current = selectedID.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
        selectedID = ids[min(max(current + delta, 0), ids.count - 1)]
        return .handled
    }
}
