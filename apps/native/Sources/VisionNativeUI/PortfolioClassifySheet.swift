import SwiftUI
import VisionNativeCore

/// `ClassifyHoldingsDialog` (ADR-267): edit sector, issuer country and issuer for one holding
/// or many at once. Saved values are manual; source imports no longer overwrite them.
struct PortfolioClassifySheet: View {
    @Bindable var model: PortfolioClassificationModel
    let editing: PortfolioEditingModel
    let portfolio: PortfolioModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var locale: Locale { LanguageLocale.locale(strings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VisionDialogHeader(
                title: title, description: strings.t("portfolio.classify.description"),
                closeLabel: strings.t("common.close"), onClose: { model.close() })
            if model.isLoading && model.data == nil {
                Text(strings.t("common.loading")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let error = model.loadError { errorText(error) }
            if let error = model.saveError { errorText(error) }
            if model.data != nil, !model.single { toolbar }
            if model.data != nil { table }
            Text(strings.t("portfolio.classify.manualWins")).font(.caption).foregroundStyle(theme.secondaryLabel)
            VisionDialogFooter {
                Button(strings.t("common.cancel")) { model.close() }.buttonStyle(.visionOutline)
                Button {
                    Task {
                        if await editing.saveClassifications() { await portfolio.loadExposure(force: true) }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if model.isSaving { ProgressView().controlSize(.small) }
                        Text(strings.t("common.save"))
                    }
                }
                .buttonStyle(.visionPrimary)
                .disabled(model.changes.count == 0 || model.isSaving)
            }
        }
        .padding(24)
        .frame(width: 896)
        .frame(maxHeight: 760)
    }

    private var title: String {
        if model.single, let holding = model.holdings.first {
            return strings.t("portfolio.classify.titleOne", ["name": holding.name])
        }
        return strings.t("portfolio.classify.title")
    }

    private func errorText(_ message: String) -> some View {
        Text(message).font(.footnote).foregroundStyle(theme.destructive)
    }

    // MARK: Search and bulk edit

    private var toolbar: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.tertiaryLabel).accessibilityHidden(true)
                TextField(strings.t("portfolio.classify.search"), text: $model.search).textFieldStyle(.vision)
                    .accessibilityLabel(strings.t("portfolio.classify.search"))
            }
            if !model.selected.isEmpty {
                HStack(spacing: 8) {
                    Text(strings.tc("portfolio.classify.selected", model.selected.count))
                        .font(.footnote.weight(.medium)).monospacedDigit()
                    sectorField(text: $model.bulkSector, placeholder: strings.t("portfolio.exposure.sector"))
                        .accessibilityLabel(strings.t("portfolio.classify.bulkSector"))
                        .frame(width: 192)
                    CountryPicker(
                        value: model.bulkCountry, strings: strings, locale: locale,
                        label: strings.t("portfolio.classify.bulkCountry")
                    ) { model.bulkCountry = $0 }
                    .frame(width: 192)
                    Button(strings.t("portfolio.classify.apply")) { model.applyToSelected() }
                        .buttonStyle(.vision(.secondary, size: .sm)).disabled(!model.canApplyToSelected)
                    Button(strings.t("portfolio.classify.deselect")) { model.selected = [] }
                        .buttonStyle(.vision(.ghost, size: .sm))
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .fill(theme.foreground.opacity(0.04)))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(strings.t("portfolio.classify.bulkLabel"))
            }
        }
    }

    // MARK: Table

    private var table: some View {
        let visible = model.visible(locale: locale)
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        return ScrollView {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 0) {
                GridRow {
                    if !model.single {
                        Toggle(
                            "",
                            isOn: Binding(
                                get: { model.allVisibleSelected(locale: locale) },
                                set: { model.setAllVisibleSelected($0, locale: locale) })
                        )
                        .labelsHidden().toggleStyle(.visionCheckboxLabelless)
                        .accessibilityLabel(strings.t("portfolio.classify.selectAll"))
                    }
                    header("portfolio.classify.holding")
                    header("portfolio.exposure.sector")
                    header("portfolio.exposure.issuerCountry")
                    header("portfolio.exposure.issuer")
                    Color.clear.frame(width: 32, height: 1).accessibilityLabel(strings.t("common.clear"))
                }
                .padding(.vertical, 8)
                ForEach(visible, id: \.investmentId) { holding in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    row(holding)
                }
                if visible.isEmpty {
                    Divider().gridCellUnsizedAxes(.horizontal)
                    Text(strings.t("portfolio.classify.empty")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                        .padding(16).gridCellColumns(model.single ? 5 : 6)
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(minHeight: 120)
        .clipShape(shape)
        .overlay(shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }

    private func header(_ key: String) -> some View {
        Text(strings.t(key)).font(.caption.weight(.medium)).foregroundStyle(theme.secondaryLabel)
    }

    private func row(_ holding: ClassifiableHolding) -> some View {
        let draft = model.draft(for: holding)
        let label = holding.symbol.map { "\(holding.name) (\($0))" } ?? holding.name
        return GridRow(alignment: .center) {
            if !model.single {
                Toggle(
                    "",
                    isOn: Binding(
                        get: { model.selected.contains(holding.investmentId) },
                        set: { model.setSelected(holding, $0) })
                )
                .labelsHidden().toggleStyle(.visionCheckboxLabelless)
                .accessibilityLabel(strings.t("portfolio.classify.select", ["name": label]))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.subheadline).lineLimit(1).truncationMode(.tail)
                HStack(spacing: 6) {
                    Text(strings.t("portfolio.assetClass.\(holding.assetClass)"))
                    if let classification = holding.classification {
                        VisionBadge(
                            text: strings.t(
                                classification.origin == .manual
                                    ? "portfolio.classify.originManual" : "portfolio.classify.originImport"),
                            tone: .secondary, small: true)
                    }
                    if holding.hasFundDocument {
                        VisionBadge(text: strings.t("portfolio.classify.lookThrough"), tone: .outline, small: true)
                    }
                }
                .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            .frame(minWidth: 160, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
            sectorField(
                text: Binding(get: { draft.sector }, set: { value in model.update(holding) { $0.sector = value } }),
                placeholder: strings.t("portfolio.classify.sectorPlaceholder")
            )
            .accessibilityLabel(strings.t("portfolio.classify.sectorFor", ["name": label]))
            .frame(minWidth: 160)
            CountryPicker(
                value: draft.country, strings: strings, locale: locale,
                label: strings.t("portfolio.classify.countryFor", ["name": label])
            ) { code in model.update(holding) { $0.country = code } }
            .frame(minWidth: 144)
            TextField(
                holding.name,
                text: Binding(
                    get: { draft.issuerName },
                    set: { value in model.update(holding) { $0.issuerName = String(value.prefix(256)) } })
            )
            .textFieldStyle(.vision)
            .accessibilityLabel(strings.t("portfolio.classify.issuerFor", ["name": label]))
            .frame(minWidth: 144)
            Group {
                if !draft.isEmpty {
                    Button {
                        model.clear(holding)
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.vision(.ghost, size: .iconSm))
                    .accessibilityLabel(strings.t("portfolio.classify.clearFor", ["name": label]))
                } else {
                    Color.clear
                }
            }
            .frame(width: 32, height: 32)
        }
        .padding(.vertical, 8)
        .background(model.isChanged(holding) ? theme.primary.opacity(0.04) : Color.clear)
    }

    /// The sector input with the `classify-sector-options` suggestions (sectors in use and the
    /// GICS names), at most 128 characters.
    private func sectorField(text: Binding<String>, placeholder: String) -> some View {
        TextField(
            placeholder,
            text: Binding(get: { text.wrappedValue }, set: { text.wrappedValue = String($0.prefix(128)) })
        )
        .textFieldStyle(.vision)
        .textInputSuggestions {
            let typed = text.wrappedValue.trimmingCharacters(in: .whitespaces).lowercased(with: locale)
            ForEach(
                model.sectorSuggestions(locale: locale).filter {
                    typed.isEmpty || $0.lowercased(with: locale).contains(typed)
                }, id: \.self
            ) { sector in
                Text(sector).textInputCompletion(sector)
            }
        }
    }
}

/// `CountryCombobox`: a searchable issuer-country picker storing the ISO alpha-2 code; empty
/// is none.
private struct CountryPicker: View {
    let value: String
    let strings: any Localizing
    let locale: Locale
    let label: String
    let onChange: (String) -> Void
    @State private var isOpen = false
    @State private var search = ""

    var body: some View {
        let options = PortfolioCountryOptions.options(locale: locale)
        let selected = options.first { $0.code == value }
        PickerButton(
            label: selected?.name ?? (value.isEmpty ? nil : value),
            placeholder: strings.t("portfolio.classify.countryPlaceholder"), isOpen: $isOpen
        ) {
            PickerList(
                search: $search, searchPlaceholder: strings.t("portfolio.classify.countrySearch"),
                emptyText: strings.t("portfolio.classify.countryEmpty"), options: pickerOptions(options)
            )
        }
        .accessibilityLabel(label)
        .onChange(of: isOpen) { _, open in
            if !open { search = "" }
        }
    }

    private func pickerOptions(_ options: [PortfolioCountryOptions.Option]) -> [PickerOption] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased(with: locale)
        var rows: [PickerOption] = []
        if !value.isEmpty, needle.isEmpty {
            rows.append(
                PickerOption(id: "__none__", title: strings.t("portfolio.classify.countryNone"), isNone: true) {
                    pick("")
                })
        }
        for option in options
        where needle.isEmpty || "\(option.name) \(option.code)".lowercased(with: locale).contains(needle) {
            rows.append(
                PickerOption(id: option.code, title: option.name, detail: option.code, isSelected: option.code == value)
                {
                    pick(option.code)
                })
        }
        return rows
    }

    private func pick(_ code: String) {
        isOpen = false
        onChange(code)
    }
}
