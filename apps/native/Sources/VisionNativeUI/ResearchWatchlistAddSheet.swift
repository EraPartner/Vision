import SwiftUI
import VisionNativeCore

/// Shared by the Watchlist search path and the Market Lookup prefilled path.
public struct ResearchWatchlistAddSheet: View {
    let model: ResearchWatchlistAddModel
    let shell: NativeShellModel
    @FocusState private var targetFocused: Bool
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchWatchlistAddModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text(strings.t("addWatchlist.title")).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    model.close()
                } label: {
                    Image(systemName: "xmark")
                }.buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel(strings.t("common.close")).disabled(model.isSubmitting)
            }
            if let asset = model.selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ResearchCard {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(asset.name).font(.headline)
                                    Text(asset.symbol).font(.caption.monospaced())
                                }
                                Spacer()
                                Button(strings.t("addWatchlist.change")) { model.changeAsset() }
                            }
                            if let price = model.quote?.price, price > 0 {
                                Text(
                                    strings.t(
                                        "addWatchlist.currentPrice",
                                        [
                                            "price": price.formatted(
                                                Decimal.FormatStyle(locale: Locale(identifier: "en_US_POSIX"))
                                                    .grouping(.never).precision(.fractionLength(2)).rounded(
                                                        rule: .toNearestOrAwayFromZero))
                                        ])
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        HStack(alignment: .top, spacing: 18) {
                            Picker(strings.t("addWatchlist.assetClass"), selection: field(\.assetClass)) {
                                ForEach(["stock", "etf", "crypto", "metals"], id: \.self) {
                                    Text(strings.t("addWatchlist." + $0)).tag($0)
                                }
                            }
                            Picker(strings.t("addWatchlist.currency"), selection: field(\.currency)) {
                                ForEach(currencyChoices, id: \.self) { Text($0).tag($0) }
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(strings.t("addWatchlist.targetPrice")).font(.caption)
                            TextField(placeholder, text: field(\.targetPrice)).textFieldStyle(.roundedBorder)
                                .accessibilityLabel(strings.t("addWatchlist.targetPrice"))
                                .focused($targetFocused).onSubmit { Task { await model.submit() } }
                            if let preview = model.preview {
                                Text(
                                    strings.t(
                                        preview.direction == "below"
                                            ? "addWatchlist.belowCurrent" : "addWatchlist.aboveCurrent",
                                        [
                                            "n": ResearchWatchlistUI.percent(
                                                preview.absolutePercent, digits: 1, shell: shell)
                                        ])
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                            if model.validationFailed {
                                Text(strings.t("addWatchlist.invalidTarget")).font(.caption).foregroundStyle(
                                    theme.destructive)
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(strings.t("addWatchlist.notesOptional")).font(.caption)
                            TextField(strings.t("addWatchlist.notesPlaceholder"), text: field(\.notes), axis: .vertical)
                                .lineLimit(2...5).textFieldStyle(.roundedBorder)
                                .accessibilityLabel(strings.t("addWatchlist.notesOptional"))
                        }
                        if model.error != nil {
                            Text(strings.t("addWatchlist.failed")).foregroundStyle(theme.destructive).font(.callout)
                            if let error = model.error {
                                Text(error).font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }.disabled(model.isSubmitting)
                }
                HStack {
                    Spacer()
                    Button(strings.t("common.cancel")) { model.close() }.disabled(model.isSubmitting)
                    Button {
                        Task { await model.submit() }
                    } label: {
                        if model.isSubmitting { ProgressView().controlSize(.small) }
                        Text(strings.t("addWatchlist.submit"))
                    }.buttonStyle(.borderedProminent)
                        .disabled(model.draft.targetPrice.isEmpty || model.isSubmitting || model.hasUncertainCreate)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text(strings.t("addWatchlist.searchLabel")).font(.caption)
                    ResearchSymbolSearchView(
                        text: Binding(get: { model.query }, set: model.updateSearch), items: model.searchResults,
                        isOpen: model.query.count >= 2, isFetching: model.isSearching,
                        placeholder: strings.t("addWatchlist.searchPlaceholder"), autoFocus: true,
                        onEscape: model.close, shell: shell,
                        onSelect: model.select)
                    Spacer(minLength: 200)
                }
            }
        }.padding(24).frame(width: 480, height: model.selected == nil ? 540 : 560)
            .interactiveDismissDisabled(model.isSubmitting)
            .onChange(of: model.validationRevision) { _, _ in targetFocused = true }
    }
    private var currencyChoices: [String] {
        let standard = ["USD", "EUR", "GBP"]
        return standard.contains(model.draft.currency) ? standard : standard + [model.draft.currency]
    }
    private var placeholder: String {
        guard let price = model.quote?.price, price > 0 else { return strings.t("addWatchlist.targetPlaceholder") }
        let rounded = NSDecimalNumber(decimal: price).rounding(
            accordingToBehavior:
                NSDecimalNumberHandler(
                    roundingMode: .plain, scale: 2, raiseOnExactness: false, raiseOnOverflow: false,
                    raiseOnUnderflow: false, raiseOnDivideByZero: false)
        ).decimalValue
        return strings.t(
            "addWatchlist.currentPrice", ["price": LocaleNumber.editable(rounded, format: shell.settings.numberFormat)])
    }
    private func field(_ key: WritableKeyPath<ResearchWatchlistAddDraft, String>) -> Binding<String> {
        Binding(get: { model.draft[keyPath: key] }, set: { value in model.update { $0[keyPath: key] = value } })
    }
}
