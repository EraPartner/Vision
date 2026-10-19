import SwiftUI
import VisionNativeCore

struct ResearchChartBuilderSearchView: View {
    @Bindable var model: ResearchChartBuilderModel
    let shell: NativeShellModel
    @State private var selected = -1
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var count: Int { model.tickerResults.count + model.macroResults.count }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        TextField(strings.t("research.builder.addSeries"), text: $model.searchText).textFieldStyle(.vision)
            .focused($focused)
            .accessibilityLabel(strings.t("research.builder.addSeries"))
            .onKeyPress(.downArrow) { move(1) }.onKeyPress(.upArrow) { move(-1) }
            .onKeyPress(.return) {
                guard model.isSearchOpen, count > 0, selected >= 0 else { return .ignored }
                select(selected)
                return .handled
            }
            .onKeyPress(.escape) {
                guard model.isSearchOpen else { return .ignored }
                model.searchText = ""
                return .handled
            }
            .overlay(alignment: .topLeading) { if model.isSearchOpen && focused { popup.offset(y: 34) } }
            .frame(maxWidth: 680).zIndex(model.isSearchOpen ? 20 : 0)
            .onChange(of: model.searchText) { _, _ in selected = -1 }
            .onChange(of: count) { _, value in if selected >= value { selected = -1 } }
    }
    private var popup: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if count == 0 && !model.isTickerSearching && !model.isMacroSearching {
                        Text(
                            strings.t(
                                model.searchError != nil || model.searchMeta?.source == "unavailable"
                                    ? "research.searchFailed" : "research.noResults")
                        ).font(.callout).foregroundStyle(theme.secondaryLabel).padding(12)
                    }
                    if !model.tickerResults.isEmpty && !model.macroResults.isEmpty {
                        group("research.builder.groupMarkets")
                    }
                    ForEach(Array(model.tickerResults.enumerated()), id: \.offset) { index, item in
                        Button {
                            select(index)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "plus").foregroundStyle(theme.secondaryLabel).accessibilityHidden(
                                    true)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.symbol ?? "").font(.callout.monospaced())
                                    if let name = item.name {
                                        Text(name).font(.caption).foregroundStyle(theme.secondaryLabel)
                                    }
                                }
                                Spacer()
                                if let type = item.type {
                                    Text(type).font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                                if let exchange = item.exchange {
                                    Text(exchange).font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                            }.padding(10).background(selected == index ? theme.primary.opacity(0.08) : .clear)
                        }.buttonStyle(.plain).id(index).onHover { if $0 { selected = index } }.accessibilityAddTraits(
                            selected == index ? .isSelected : [])
                    }
                    if !model.macroResults.isEmpty { group("research.builder.groupEconomic") }
                    ForEach(Array(model.macroResults.enumerated()), id: \.offset) { index, item in
                        let row = model.tickerResults.count + index
                        Button {
                            select(row)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "plus").foregroundStyle(theme.secondaryLabel).accessibilityHidden(
                                    true)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title).font(.callout)
                                    HStack {
                                        if let region = item.region { Text(region) }
                                        if let units = item.units { Text(units) }
                                    }.font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                                Spacer()
                                if let source = item.source {
                                    Text(source).font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                            }.padding(10).background(selected == row ? theme.primary.opacity(0.08) : .clear)
                        }.buttonStyle(.plain).id(row).onHover { if $0 { selected = row } }.accessibilityAddTraits(
                            selected == row ? .isSelected : [])
                    }
                }
            }.frame(
                height: min(
                    384,
                    CGFloat(max(1, count)) * 58
                        + CGFloat(model.macroResults.isEmpty ? 12 : model.tickerResults.isEmpty ? 38 : 64))
            )
            .onChange(of: selected) { _, value in
                if value >= 0 { withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(value, anchor: .center) } }
            }
        }.background(theme.card, in: RoundedRectangle(cornerRadius: 8)).overlay(
            RoundedRectangle(cornerRadius: 8).stroke(theme.border)
        ).shadow(color: .black.opacity(0.15), radius: 12, y: 6)
    }
    private func group(_ key: String) -> some View {
        Text(strings.t(key)).font(.caption).foregroundStyle(theme.tertiaryLabel).padding(.horizontal, 12).padding(
            .top, 9
        ).padding(.bottom, 4)
    }
    private func move(_ delta: Int) -> KeyPress.Result {
        guard model.isSearchOpen, count > 0 else { return .ignored }
        selected = selected < 0 ? (delta > 0 ? 0 : count - 1) : (selected + delta + count) % count
        return .handled
    }
    private func select(_ index: Int) {
        guard index >= 0, index < count else { return }
        if index < model.tickerResults.count {
            if let symbol = model.tickerResults[index].symbol { model.addSeries(symbol: symbol) }
        } else {
            model.addMacro(item: model.macroResults[index - model.tickerResults.count])
        }
    }
}
