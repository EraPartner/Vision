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
                                    get: { model.printLocalState.selection[String(chart.id)] },
                                    set: { model.printLocalState.selection[String(chart.id)] = $0 }),
                                range: Binding(
                                    get: { model.printLocalState.rangeStart[String(chart.id)] },
                                    set: { model.printLocalState.rangeStart[String(chart.id)] = $0 }))
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
            await model.appear(snapshot: snapshot, currency: settings.defaultCurrency, strings: strings)
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
                Text(strings.t("customChart.historicalFxFallback")).font(.caption).foregroundStyle(.orange)
            }
            if dataset.entities.isEmpty {
                Text(strings.t("customChart.noSeries"))
            } else if kind == .rankedBar {
                InsightRankedChart(
                    rows: entities, settings: settings, currency: settings.defaultCurrency, strings: strings,
                    initialSelection: selection.wrappedValue, onSelectionChange: { selection.wrappedValue = $0 })
            } else {
                InsightTimelineChart(
                    series: series, currency: settings.defaultCurrency, settings: settings,
                    title: strings.t("customChart.builder.preview"), bars: kind.chartType == "bar",
                    areas: kind.chartType == "area",
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
        VStack(alignment: .leading, spacing: 16) {
            Text(
                strings.t(model.editingId == nil ? "customChart.builder.createTitle" : "customChart.builder.editTitle")
            ).font(.visionCardTitle)
            Text(strings.t("customChart.builder.desc")).foregroundStyle(theme.secondaryLabel)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    TextField(strings.t("customChart.builder.name"), text: binding(\.name)).textFieldStyle(
                        .vision)
                    HStack {
                        Picker(strings.t("customChart.chartType"), selection: binding(\.kind)) {
                            ForEach(CustomChartKind.allCases, id: \.self) { Text(strings.t($0.labelKey)).tag($0) }
                        }
                        Picker(strings.t("customChart.timeBucket"), selection: binding(\.timeBucket)) {
                            Text(strings.t("customChart.monthly")).tag("monthly")
                            Text(strings.t("customChart.yearly")).tag("yearly")
                        }.pickerStyle(.segmented)
                    }
                    HStack {
                        dateField(\.dateRangeStart, key: "customChart.dateFrom")
                        dateField(\.dateRangeEnd, key: "customChart.dateTo")
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
                    Text(strings.t("customChart.builder.preview")).font(.headline)
                    if model.isPreviewLoading {
                        ProgressView().frame(height: 240)
                    } else if let preview = model.preview {
                        CustomChartPlot(dataset: preview, kind: draft.kind, settings: settings, strings: strings)
                    } else if let error = model.previewError {
                        Text(error).foregroundStyle(theme.destructive)
                    }
                    if let error = model.saveError { Text(error).foregroundStyle(theme.destructive) }
                }.padding(.trailing, 8)
            }
            HStack {
                Spacer()
                Button(strings.t("common.cancel")) { model.close() }.keyboardShortcut(.cancelAction).disabled(
                    model.isSaving)
                Button(strings.t(model.isSaving ? "customChart.saving" : "customChart.builder.save")) {
                    Task { await model.save() }
                }
                .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction).disabled(
                    !draft.canSave || model.isSaving)
            }
        }.padding(24).frame(width: 740, height: 740).interactiveDismissDisabled(model.isSaving)
            .task(id: model.draft) { await model.refreshPreview() }
    }
    private var categoryOptions: [ChartPickerOption] {
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
    private func entitySection(
        title: String, allKey: String, addKey: String, all: Binding<Bool>, selected: Binding<[Int]>,
        options: [ChartPickerOption]
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(strings.t(title)).font(.headline)
                Spacer()
                Toggle(strings.t(allKey), isOn: all)
            }
            if all.wrappedValue {
                Text(strings.t("customChart.allHint")).font(.caption).foregroundStyle(theme.secondaryLabel)
            } else {
                ChartEntityPicker(title: strings.t(addKey), options: options, selection: selected, strings: strings)
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(selected.wrappedValue, id: \.self) { id in
                            let name = options.first { $0.id == id }?.name ?? String(id)
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

private struct ChartPickerOption: Identifiable {
    let id: Int
    let name: String
}
private struct ChartEntityPicker: View {
    let title: String
    let options: [ChartPickerOption]
    @Binding var selection: [Int]
    let strings: any Localizing
    @State private var isOpen = false
    @State private var search = ""
    var body: some View {
        Button(title) { isOpen.toggle() }.buttonStyle(.visionOutline)
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
