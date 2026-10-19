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
            VisionDialogHeader(
                title: strings.t("addWatchlist.title"), closeLabel: strings.t("common.close"),
                onClose: { model.close() }
            )
            .keyboardShortcut(.cancelAction).disabled(model.isSubmitting)
            if let asset = model.selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // `rounded-card bg-foreground/[0.04] p-3`.
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .center) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(asset.name).font(.body.weight(.medium)).foregroundStyle(theme.foreground)
                                    Text(asset.symbol).font(.caption.monospaced())
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                                                .strokeBorder(theme.border, lineWidth: 1))
                                }
                                Spacer()
                                Button(strings.t("addWatchlist.change")) { model.changeAsset() }
                                    .buttonStyle(.borderless).controlSize(.small)
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
                                .font(.footnote).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            theme.foreground.opacity(0.04),
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                        HStack(alignment: .top, spacing: 16) {
                            VStack(alignment: .leading, spacing: 8) {
                                fieldLabel(strings.t("addWatchlist.assetClass"))
                                Picker(strings.t("addWatchlist.assetClass"), selection: field(\.assetClass)) {
                                    ForEach(["stock", "etf", "crypto", "metals"], id: \.self) {
                                        Text(strings.t("addWatchlist." + $0)).tag($0)
                                    }
                                }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            VStack(alignment: .leading, spacing: 8) {
                                fieldLabel(strings.t("addWatchlist.currency"))
                                Picker(strings.t("addWatchlist.currency"), selection: field(\.currency)) {
                                    ForEach(currencyChoices, id: \.self) { Text($0).tag($0) }
                                }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            fieldLabel(strings.t("addWatchlist.targetPrice"))
                            TextField(placeholder, text: field(\.targetPrice)).textFieldStyle(.vision)
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
                        VStack(alignment: .leading, spacing: 8) {
                            fieldLabel(strings.t("addWatchlist.notesOptional"))
                            TextField(strings.t("addWatchlist.notesPlaceholder"), text: field(\.notes), axis: .vertical)
                                .lineLimit(2...5).textFieldStyle(.vision)
                                .accessibilityLabel(strings.t("addWatchlist.notesOptional"))
                        }
                        if model.error != nil {
                            Text(strings.t("addWatchlist.failed")).foregroundStyle(theme.destructive).font(.callout)
                            if let error = model.error {
                                Text(error).font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }.padding(.horizontal, 1).disabled(model.isSubmitting)
                }
                VisionDialogFooter {
                    Button(strings.t("common.cancel")) { model.close() }.buttonStyle(.visionOutline)
                        .disabled(model.isSubmitting)
                    Button {
                        Task { await model.submit() }
                    } label: {
                        if model.isSubmitting { ProgressView().controlSize(.small) }
                        Text(strings.t("addWatchlist.submit"))
                    }.buttonStyle(.visionPrimary)
                        .disabled(model.draft.targetPrice.isEmpty || model.isSubmitting || model.hasUncertainCreate)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    fieldLabel(strings.t("addWatchlist.searchLabel"))
                    ResearchSymbolSearchView(
                        text: Binding(get: { model.query }, set: { value in model.updateSearch(value) }),
                        items: model.searchResults,
                        isOpen: model.query.count >= 2, isFetching: model.isSearching,
                        placeholder: strings.t("addWatchlist.searchPlaceholder"), autoFocus: true,
                        onEscape: model.close, shell: shell,
                        onSelect: model.select)
                    Spacer(minLength: 200)
                }
            }
        }.visionDialogPadding().frame(width: 448, height: model.selected == nil ? 540 : 560)
            .interactiveDismissDisabled(model.isSubmitting)
            .onChange(of: model.validationRevision) { _, _ in targetFocused = true }
    }
    /// The web `Label`: `type-body font-medium text-label-primary` above its input.
    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.body.weight(.medium)).foregroundStyle(theme.foreground)
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
