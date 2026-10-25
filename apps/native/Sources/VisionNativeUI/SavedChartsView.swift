import SwiftUI
import VisionNativeCore

struct SavedChartsView: View {
    let model: SavedChartsModel
    let snapshot: StatisticsSnapshot
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text(strings.t("customChart.tab")).font(Font.visionTitle3)
                if !model.charts.isEmpty {
                    Text(strings.tc("customChart.savedCount", model.charts.count)).foregroundStyle(theme.secondaryLabel)
                }
                Spacer()
                Button(strings.t("customChart.newChart")) { model.begin() }.buttonStyle(.visionPrimary)
            }
            if model.isLoading {
                ProgressView().padding()
            } else if model.charts.isEmpty {
                Button(strings.t("customChart.createFirst")) { model.begin() }.buttonStyle(.visionOutline)
            }
            ForEach(model.charts, id: \.id) { chart in
                AdminCard(padding: VisionPageLayout.padding) {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text(chart.name).font(Font.visionTitle3).lineLimit(1)
                            Spacer()
                            Menu {
                                Button(strings.t("common.edit")) { model.begin(chart: chart) }
                                Button(strings.t("common.delete"), role: .destructive) { model.pendingDelete = chart }
                            } label: {
                                Image(systemName: "ellipsis")
                            }
                            .menuIndicator(.hidden)
                            .accessibilityLabel(strings.t("customChart.menu", ["name": chart.name]))
                        }
                        if let dataset = model.datasets[chart.id] {
                            CustomChartPlot(
                                dataset: dataset, kind: CustomChartDraft(chart: chart).kind, settings: settings,
                                strings: strings,
                                selection: Binding(
                                    get: { model.printLocalState.selection[String(chart.id.rawValue)] },
                                    set: { model.printLocalState.selection[String(chart.id.rawValue)] = $0 }),
                                range: Binding(
                                    get: { model.printLocalState.rangeStart[String(chart.id.rawValue)] },
                                    set: { model.printLocalState.rangeStart[String(chart.id.rawValue)] = $0 }))
                        } else if let error = model.errors[chart.id] {
                            Text(error).foregroundStyle(theme.destructive)
                        } else {
                            ProgressView()
                        }
                    }
                }
            }
            if let error = model.error { Text(error).foregroundStyle(theme.destructive) }
        }
        .task(id: snapshot) {
            await model.appear(snapshot: snapshot, currency: LedgerCurrency.display(settings), strings: strings)
        }
        .sheet(isPresented: Binding(get: { model.draft != nil }, set: { if !$0 { model.close() } })) {
            CustomChartBuilderSheet(model: model, snapshot: snapshot, settings: settings, strings: strings)
        }
        .alert(
            strings.t("customChart.deleteTitle"),
            isPresented: Binding(get: { model.pendingDelete != nil }, set: { if !$0 { model.pendingDelete = nil } })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { model.pendingDelete = nil }
            Button(strings.t("common.delete"), role: .destructive) { Task { await model.confirmDelete() } }
        } message: {
            Text(strings.t("customChart.deleteDesc", ["name": model.pendingDelete?.name ?? ""]))
        }
    }
}

struct CustomChartPlot: View {
    let dataset: CustomChartDataset
    let kind: CustomChartKind
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    private let externalSelection: Binding<String?>?
    private let externalRange: Binding<String?>?
    @State private var localSelection: String?
    @State private var localRange: String?
    private var selection: Binding<String?> { externalSelection ?? $localSelection }
    private var range: Binding<String?> { externalRange ?? $localRange }
    init(
        dataset: CustomChartDataset, kind: CustomChartKind, settings: NativeAppSettings, strings: any Localizing,
        selection: Binding<String?>? = nil, range: Binding<String?>? = nil
    ) {
        self.dataset = dataset
        self.kind = kind
        self.settings = settings
        self.strings = strings
        externalSelection = selection
        externalRange = range
    }
    private var entities: [CustomChartEntity] {
        dataset.entities.map { entity in
            entity.id == "other"
                ? CustomChartEntity(id: entity.id, name: strings.t("customChart.other"), values: entity.values) : entity
        }
    }
    private var series: [InsightChartSeries] {
        entities.map { entity in
            InsightChartSeries(
                id: entity.id, label: entity.name,
                points: dataset.periods.map { InsightChartPoint(key: $0, value: entity.values[$0] ?? 0) })
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dataset.usesHistoricalFallback {
                Text(
                    strings.t(
                        "customChart.historicalFxFallback",
                        ["currencies": dataset.fallbackCurrencies.isEmpty ? "—" : dataset.fallbackCurrencies.map(\.rawValue).joined(separator: ", ")]
                    )
                ).font(.caption).foregroundStyle(theme.warning)
            }
            // No stored rate at all: left out, never added 1:1 (ADR-216).
            if dataset.unconvertedCount > 0 {
                Text(strings.tc("common.fxUnavailableTransactions", dataset.unconvertedCount))
                    .font(.footnote).foregroundStyle(theme.warning)
            }
            if dataset.entities.isEmpty {
                Text(strings.t("customChart.noSeries"))
            } else if kind == .rankedBar {
                InsightRankedChart(
                    rows: entities, settings: settings, currency: LedgerCurrency.display(settings), strings: strings,
                    initialSelection: selection.wrappedValue, onSelectionChange: { selection.wrappedValue = $0 })
            } else {
                InsightTimelineChart(
                    series: series, currency: LedgerCurrency.display(settings), settings: settings,
                    title: strings.t("customChart.builder.preview"), bars: kind.chartType == .bar,
                    areas: kind.chartType == .area,
                    stackedBars: kind == .stackedBar, stackedAreas: kind == .stackedArea, selection: selection,
                    rangeStart: range)
            }
        }
    }
}

private struct CustomChartBuilderSheet: View {
    let model: SavedChartsModel
    let snapshot: StatisticsSnapshot
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    private var draft: CustomChartDraft { model.draft ?? CustomChartDraft() }
    private func binding<Value>(_ keyPath: WritableKeyPath<CustomChartDraft, Value>) -> Binding<Value> {
        Binding(
            get: { draft[keyPath: keyPath] },
            set: { value in
                guard var next = model.draft else { return }
                next[keyPath: keyPath] = value
                model.draft = next
            })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: strings.t(
                    model.editingId == nil ? "customChart.builder.createTitle" : "customChart.builder.editTitle"),
                description: strings.t("customChart.builder.desc"), closeLabel: strings.t("common.close"),
                onClose: { model.close() }
            ).disabled(model.isSaving)
            // `grid lg:grid-cols-2 gap-6`: the form on the left, the live preview on the right.
            HStack(alignment: .top, spacing: 24) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            fieldLabel("customChart.builder.name")
                            TextField(strings.t("customChart.builder.name"), text: binding(\.name)).textFieldStyle(
                                .vision)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            fieldLabel("customChart.chartType")
                            Picker(strings.t("customChart.chartType"), selection: binding(\.kind)) {
                                ForEach(CustomChartKind.allCases, id: \.self) { Text(strings.t($0.labelKey)).tag($0) }
                            }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            fieldLabel("customChart.timeBucket")
                            Picker(strings.t("customChart.timeBucket"), selection: binding(\.timeBucket)) {
                                Text(strings.t("customChart.monthly")).tag(OpenAPI.SavedChart.TimeBucket.monthly)
                                Text(strings.t("customChart.yearly")).tag(OpenAPI.SavedChart.TimeBucket.yearly)
                            }.pickerStyle(.segmented).labelsHidden()
                        }
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 6) {
                                fieldLabel("customChart.dateFrom")
                                dateField(\.dateRangeStart, key: "customChart.dateFrom")
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            VStack(alignment: .leading, spacing: 6) {
                                fieldLabel("customChart.dateTo")
                                dateField(\.dateRangeEnd, key: "customChart.dateTo")
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        entitySection(
                            title: "customChart.categoriesLabel", allKey: "customChart.allCategories",
                            addKey: "customChart.addCategory",
                            all: binding(\.allCategories), selected: binding(\.categoryIds), options: categoryOptions)
                        entitySection(
                            title: "customChart.recipientsLabel", allKey: "customChart.allRecipients",
                            addKey: "customChart.addRecipient",
                            all: binding(\.allRecipients), selected: binding(\.recipientIds),
                            options: model.recipients.map { ChartPickerOption(id: $0.id, name: $0.name) })
                        entitySection(
                            title: "customChart.tagsLabel", allKey: "customChart.allTags", addKey: "customChart.addTag",
                            all: binding(\.allTags), selected: binding(\.tagIds),
                            options: model.tags.map { ChartPickerOption(id: $0.id, name: "#" + $0.slug) })
                    }.padding(.horizontal, 1).padding(.trailing, 8)
                }.frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 8) {
                    Text(strings.t("customChart.builder.preview")).font(.headline).foregroundStyle(theme.foreground)
                        .accessibilityAddTraits(.isHeader)
                    if model.isPreviewLoading {
                        ProgressView().frame(maxWidth: .infinity).frame(height: 240)
                    } else if let preview = model.preview {
                        CustomChartPlot(dataset: preview, kind: draft.kind, settings: settings, strings: strings)
                    } else if let error = model.previewError {
                        Text(error).foregroundStyle(theme.destructive)
                    }
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            if let error = model.saveError { Text(error).foregroundStyle(theme.destructive) }
            VisionDialogFooter {
                Button(strings.t("common.cancel")) { model.close() }.keyboardShortcut(.cancelAction)
                    .buttonStyle(.visionOutline).disabled(model.isSaving)
                Button(strings.t(model.isSaving ? "customChart.saving" : "customChart.builder.save")) {
                    Task { await model.save() }
                }
                .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction).disabled(
                    !draft.canSave || model.isSaving)
            }
        }.visionDialogPadding().frame(width: 896, height: 680).interactiveDismissDisabled(model.isSaving)
            .task(id: model.draft) { await model.refreshPreview() }
    }
    /// The web `Label`: `type-body font-medium text-label-primary` above its control.
    private func fieldLabel(_ key: String) -> some View {
        Text(strings.t(key)).font(.body.weight(.medium)).foregroundStyle(theme.foreground)
    }
    private var categoryOptions: [ChartPickerOption<CategoryID>] {
        snapshot.categories(metric: .absolute).compactMap { row in
            row.categoryIds.first.map { ChartPickerOption(id: $0, name: row.name) }
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private func dateField(_ keyPath: WritableKeyPath<CustomChartDraft, String?>, key: String) -> some View {
        VisionDateField(
            day: draft[keyPath: keyPath].flatMap(day), placeholder: strings.t(key), allowClear: true,
            settings: settings, strings: strings, calendar: .current
        ) { next in binding(keyPath).wrappedValue = next?.text(format: .isoDate) }
        .accessibilityLabel(strings.t(key))
    }
    private func day(_ value: String) -> PlannedDay? {
        guard AccountDates.isYmd(value) else { return nil }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return PlannedDay(year: parts[0], month: parts[1], day: parts[2])
    }
    private func entitySection<ID: Hashable>(
        title: String, allKey: String, addKey: String, all: Binding<Bool>, selected: Binding<[ID]>,
        options: [ChartPickerOption<ID>]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(strings.t(title)).font(.body.weight(.medium)).foregroundStyle(theme.foreground)
                Spacer()
                HStack(spacing: 8) {
                    Toggle(strings.t(allKey), isOn: all).toggleStyle(.switch).controlSize(.mini).labelsHidden()
                    Text(strings.t(allKey)).font(.footnote).foregroundStyle(theme.secondaryLabel)
                        .accessibilityHidden(true)
                }
            }
            if all.wrappedValue {
                Text(strings.t("customChart.allHint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            } else {
                ChartEntityPicker(title: strings.t(addKey), options: options, selection: selected, strings: strings)
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(selected.wrappedValue, id: \.self) { id in
                            let name = options.first { $0.id == id }?.name ?? String(describing: id)
                            Button {
                                selected.wrappedValue.removeAll { $0 == id }
                            } label: {
                                Label(name, systemImage: "xmark")
                            }
                            .buttonStyle(.visionOutline).controlSize(.small)
                            .accessibilityLabel(strings.t("customChart.removeSeries", ["name": name]))
                        }
                    }
                }
            }
        }
    }
}

private struct ChartPickerOption<ID: Hashable>: Identifiable {
    let id: ID
    let name: String
}
private struct ChartEntityPicker<ID: Hashable>: View {
    let title: String
    let options: [ChartPickerOption<ID>]
    @Binding var selection: [ID]
    let strings: any Localizing
    @State private var isOpen = false
    @State private var search = ""
    @Environment(\.visionTheme) private var theme
    var body: some View {
        // `Button variant="outline" role="combobox" className="w-full justify-between"`.
        Button {
            isOpen.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.caption)
                Text(title)
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down").font(.caption).opacity(0.5)
            }.font(.body).foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity)
        }.buttonStyle(.visionOutline).accessibilityLabel(title)
            .popover(isPresented: $isOpen) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField(strings.t("table.searchAllColumns"), text: $search).textFieldStyle(.vision)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(options.filter { search.isEmpty || $0.name.localizedStandardContains(search) }) {
                                option in
                                Button {
                                    if selection.contains(option.id) {
                                        selection.removeAll { $0 == option.id }
                                    } else {
                                        selection.append(option.id)
                                    }
                                } label: {
                                    HStack {
                                        Text(option.name)
                                        Spacer()
                                        if selection.contains(option.id) { Image(systemName: "checkmark") }
                                    }
                                    .padding(5).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }
                    }.frame(height: 240)
                }.padding(12).frame(width: 340)
            }
    }
}
