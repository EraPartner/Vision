import SwiftUI
import VisionNativeCore

struct AnalysisResultPivot: View {
    let model: AnalysisModel
    let dataset: AnalysisDataset
    let shell: NativeShellModel
    @State private var choosing: String?
    @State private var search = ""
    @State private var expandedRows: Set<String> = []
    @State private var expandedColumns: Set<String> = []
    @State private var percentages = false
    @State private var errorDetails = false
    @State private var hasRun = false
    @FocusState private var addFocus: String?
    @FocusState private var searchFocused: Bool
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var config: AnalysisPivotConfig { model.pivotConfig }
    private var result: AnalysisPivotResult? { hasRun ? model.pivotResult : nil }
    private var rowDepth: Int { min(1, config.rows.count) }
    private var columnDepth: Int { min(1, config.columns.count) }
    private var rowIDs: [String] { unique((result?.partitions ?? []) + config.rows) }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 20) {
                ForEach(["rows", "columns", "values"], id: \.self) { axis in axisEditor(axis) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("analysis.ext.pivot.filtersHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
                Text(strings.t("analysis.ext.pivot.filterField")).font(.callout.weight(.medium))
                VisionSelect(
                    selection: Binding(
                        get: { "" },
                        set: { id in
                            if !id.isEmpty {
                                model.pivotConfig.filters.append(.init(fieldId: id, operator: "eq", value: .string("")))
                            }
                        }),
                    options: filterFieldOptions,
                    accessibilityLabel: strings.t("analysis.ext.pivot.filterField"), expands: true)
                ForEach(Array(config.filters.enumerated()), id: \.offset) { index, filter in
                    HStack {
                        TextField(
                            fieldLabel(filter.fieldId),
                            text: Binding(
                                get: {
                                    filter.value == .null || filter.value == nil
                                        ? "" : AnalysisPresentation.rawText(filter.value)
                                },
                                set: { text in
                                    guard model.pivotConfig.filters.indices.contains(index) else { return }
                                    model.pivotConfig.filters[index].value =
                                        dataset.fields.first { $0.id == filter.fieldId }?.type == "boolean"
                                        ? .bool(text == "true") : .string(text)
                                }))
                        Button(strings.t("analysis.ext.remove")) { model.pivotConfig.filters.remove(at: index) }
                            .buttonStyle(.visionOutline).controlSize(.small)
                    }
                }
            }
            HStack {
                Button(strings.t(model.isPivotLoading ? "analysis.ext.pivot.running" : "analysis.ext.pivot.run")) {
                    hasRun = true
                    Task { await model.runPivot() }
                }.buttonStyle(.visionPrimary).disabled(model.isPivotLoading || config.values.isEmpty)
                Toggle(strings.t("analysis.ext.pivot.share"), isOn: $percentages).toggleStyle(.visionSwitch)
            }
            if let error = model.pivotError {
                VStack(alignment: .leading) {
                    Text(strings.t("analysis.ext.pivot.failed"))
                    DisclosureGroup(strings.t("analysis.ext.pivot.errorDetails"), isExpanded: $errorDetails) {
                        Text(verbatim: error).textSelection(.enabled).padding(.top, 8)
                    }
                }.foregroundStyle(theme.destructive)
            } else if result == nil && !model.isPivotLoading {
                Text(
                    strings.t(
                        config.values.isEmpty
                            ? "analysis.ext.pivot.chooseValue"
                            : hasRun ? "analysis.ext.pivot.rerun" : "analysis.ext.pivot.ready")
                )
                .foregroundStyle(theme.secondaryLabel)
            }
            if let result {
                if result.coverage.financialComplete == false {
                    Text(
                        strings.t(
                            "analysis.ext.pivot.partial", ["missing": String(result.coverage.unavailableRows ?? 0)])
                    )
                    .foregroundStyle(theme.warning)
                }
                Text(strings.t("analysis.ext.pivot.complete", ["rows": String(result.coverage.rows)]))
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                if visibleRows.isEmpty { Text(strings.t("analysis.ext.pivot.empty")) } else { matrix }
            }
        }.onChange(of: config) {
            choosing = nil
            search = ""
            expandedRows = []
            expandedColumns = []
        }
        .onChange(of: model.plan) {
            expandedRows = []
            expandedColumns = []
        }
    }
    private var filterFieldOptions: [VisionSelectOption<String>] {
        var options = [VisionSelectOption(value: "", title: "—")]
        for field in dataset.fields { options.append(VisionSelectOption(value: field.id, title: fieldLabel(field.id))) }
        return options
    }
    private func axisEditor(_ axis: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("analysis.ext.pivot.\(axis)")).font(.headline)
            Text(strings.t("analysis.ext.pivot.\(axis)Help")).font(.caption).foregroundStyle(theme.secondaryLabel)
            ForEach(Array(ids(axis).enumerated()), id: \.element) { index, id in
                HStack(spacing: 6) {
                    Text("\(index + 1). \(fieldLabel(id))").frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        move(axis, index, -1)
                    } label: {
                        Image(systemName: "chevron.up")
                    }
                    .disabled(index == 0).accessibilityLabel(
                        strings.t("analysis.ext.pivot.moveUp", ["field": fieldLabel(id)]))
                    Button {
                        move(axis, index, 1)
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                    .disabled(index + 1 == ids(axis).count).accessibilityLabel(
                        strings.t("analysis.ext.pivot.moveDown", ["field": fieldLabel(id)]))
                    Button {
                        set(axis, ids(axis).filter { $0 != id })
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel(strings.t("analysis.ext.pivot.removeField", ["field": fieldLabel(id)]))
                }.buttonStyle(.vision(.ghost, size: .iconXs)).font(.caption)
            }
            Button(strings.t("analysis.ext.pivot.addField")) {
                choosing = choosing == axis ? nil : axis
                search = ""
                searchFocused = choosing != nil
            }.buttonStyle(.visionOutline).controlSize(.small).focused($addFocus, equals: axis)
            if choosing == axis {
                VStack(alignment: .leading, spacing: 8) {
                    TextField(strings.t("analysis.ext.pivot.searchFields"), text: $search).textFieldStyle(.vision)
                        .focused($searchFocused)
                    let fields = (axis == "values" ? dataset.measures : dataset.fields).filter {
                        !ids(axis).contains($0.id)
                            && (search.isEmpty || ($0.label ?? $0.id).localizedCaseInsensitiveContains(search))
                    }
                    if fields.isEmpty { Text(strings.t("analysis.ext.pivot.noFields")).font(.caption) }
                    ScrollView {
                        LazyVStack(alignment: .leading) {
                            ForEach(fields) { field in
                                Button(fieldLabel(field.id)) {
                                    set(axis, ids(axis) + [field.id])
                                    closePicker(axis)
                                }
                                .buttonStyle(.plain).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.frame(maxHeight: 180)
                }.padding(10).background(theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
                    .onKeyPress(.escape) {
                        closePicker(axis)
                        return .handled
                    }
            }
        }.frame(maxWidth: .infinity, alignment: .topLeading)
    }
    private func closePicker(_ axis: String) {
        choosing = nil
        search = ""
        addFocus = axis
    }
    private func ids(_ axis: String) -> [String] {
        axis == "rows" ? config.rows : axis == "columns" ? config.columns : config.values
    }
    private func set(_ axis: String, _ ids: [String]) {
        if axis == "rows" {
            model.pivotConfig.rows = ids
        } else if axis == "columns" {
            model.pivotConfig.columns = ids
        } else {
            model.pivotConfig.values = ids
        }
    }
    private func move(_ axis: String, _ index: Int, _ by: Int) {
        var values = ids(axis)
        guard values.indices.contains(index + by) else { return }
        values.swapAt(index, index + by)
        set(axis, values)
    }
    private func fieldLabel(_ id: String) -> String {
        let label = (dataset.fields + dataset.measures).first { $0.id == id }?.label ?? id
        return AnalysisPresentation.catalogLabel(label, strings: strings)
    }
    private func key(_ row: AnalysisRow, ids: [String], depth: Int) -> String {
        let value = TaxValue.array([.number(Decimal(depth))] + ids.map { row[$0] ?? .null })
        return (try? String(decoding: APIBody.encode(value), as: UTF8.self)) ?? ""
    }
    private func rowKey(_ row: AnalysisRow, _ depth: Int) -> String {
        key(row, ids: unique((result?.partitions ?? []) + Array(config.rows.prefix(depth))), depth: depth)
    }
    private func columnKey(_ row: AnalysisRow, _ depth: Int) -> String {
        key(row, ids: Array(config.columns.prefix(depth)), depth: depth)
    }
    private func sorted(_ values: [AnalysisRow], ids: [String]) -> [AnalysisRow] {
        values.sorted { a, b in
            for id in ids {
                let first = a[id] == nil || a[id] == .null ? "" : AnalysisPresentation.rawText(a[id])
                let second = b[id] == nil || b[id] == .null ? "" : AnalysisPresentation.rawText(b[id])
                let order = first.compare(second, options: [.numeric], locale: Locale.current)
                if order != .orderedSame { return order == .orderedAscending }
            }
            return false
        }
    }
    private struct Entry: Identifiable {
        let row: AnalysisRow
        let depth: Int
        let id: String
    }
    private var visibleRows: [Entry] {
        guard let result else { return [] }
        var output: [Entry] = []
        func collect(_ depth: Int, _ parent: AnalysisRow? = nil) {
            let source = result.levels.first { $0.rowDepth == depth && $0.columnDepth == columnDepth }
            let ids = unique(result.partitions + Array(config.rows.prefix(depth)))
            let parentIDs = unique(result.partitions + Array(config.rows.prefix(max(0, depth - 1))))
            let rows =
                source?.rows.filter { row in parent == nil || parentIDs.allSatisfy { row[$0] == parent?[$0] } } ?? []
            var seen: Set<String> = []
            for row in sorted(rows, ids: ids) where seen.insert(rowKey(row, depth)).inserted {
                let key = rowKey(row, depth)
                output.append(.init(row: row, depth: depth, id: key))
                if depth < config.rows.count && expandedRows.contains(key) { collect(depth + 1, row) }
            }
        }
        collect(rowDepth)
        if !config.rows.isEmpty { collect(0) }
        return output
    }
    private var matrixColumns: [Entry] {
        guard let result else { return [] }
        var output: [Entry] = []
        func collect(_ depth: Int, _ parent: AnalysisRow? = nil) {
            let source = result.levels.first { $0.rowDepth == rowDepth && $0.columnDepth == depth }
            let parentIDs = Array(config.columns.prefix(max(0, depth - 1)))
            let rows =
                source?.rows.filter { row in parent == nil || parentIDs.allSatisfy { row[$0] == parent?[$0] } } ?? []
            var seen: Set<String> = []
            for row in sorted(rows, ids: Array(config.columns.prefix(depth)))
            where seen.insert(columnKey(row, depth)).inserted {
                let key = columnKey(row, depth)
                output.append(.init(row: row, depth: depth, id: key))
                if depth < config.columns.count && expandedColumns.contains(key) { collect(depth + 1, row) }
            }
        }
        collect(columnDepth)
        return output
    }
    private var matrix: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                GridRow {
                    ForEach(rowIDs, id: \.self) { Text(fieldLabel($0)) }
                    ForEach(matrixColumns) { entry in
                        ForEach(config.values, id: \.self) { value in
                            HStack {
                                if entry.depth < config.columns.count {
                                    expansion(
                                        key: entry.id,
                                        label: config.columns.prefix(entry.depth).map {
                                            AnalysisPresentation.rawText(entry.row[$0])
                                        }.joined(separator: " / "), columns: true)
                                }
                                Text(
                                    "\(config.columns.prefix(entry.depth).map { AnalysisPresentation.rawText(entry.row[$0]) }.joined(separator: " / ")) · \(fieldLabel(value))"
                                )
                            }
                        }
                    }
                    if !config.columns.isEmpty {
                        ForEach(config.values, id: \.self) {
                            Text("\(strings.t("analysis.ext.pivot.total")) · \(fieldLabel($0))")
                        }
                    }
                }.fontWeight(.medium)
                ForEach(visibleRows) { entry in
                    GridRow {
                        ForEach(rowIDs, id: \.self) { id in
                            HStack {
                                if entry.depth > 0 && entry.depth < config.rows.count
                                    && id == config.rows[entry.depth - 1]
                                {
                                    expansion(
                                        key: entry.id, label: AnalysisPresentation.rawText(entry.row[id]),
                                        columns: false)
                                }
                                Text(
                                    verbatim: entry.depth == 0 && id == config.rows.first
                                        ? strings.t("analysis.ext.pivot.total")
                                        : AnalysisPresentation.rawText(entry.row[id]))
                            }
                        }
                        ForEach(matrixColumns) { column in
                            ForEach(config.values, id: \.self) { id in
                                let source = result?.levels.first {
                                    $0.rowDepth == entry.depth && $0.columnDepth == column.depth
                                }
                                let cell = source?.rows.first { row in
                                    matches(row, entry) && columnKey(row, column.depth) == column.id
                                }
                                Button(displayCell(cell, id)) {
                                    guard let cell, let source else { return }
                                    let values = Dictionary(
                                        uniqueKeysWithValues: source.groups.map { ($0, cell[$0] ?? .null) })
                                    Task { await model.drill(row: values, groups: source.groups) }
                                }.buttonStyle(.plain).disabled(cell == nil).visionTooltip(strings.t("analysis.ext.pivot.drill"))
                            }
                        }
                        if !config.columns.isEmpty {
                            ForEach(config.values, id: \.self) { id in
                                let total = result?.levels.first { $0.rowDepth == entry.depth && $0.columnDepth == 0 }?
                                    .rows.first { matches($0, entry) }
                                Text(verbatim: displayCell(total, id)).fontWeight(.medium)
                            }
                        }
                    }
                }
            }.font(.caption).monospacedDigit().textSelection(.enabled).padding(12)
        }.overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.md).stroke(theme.border))
    }
    private func matches(_ row: AnalysisRow, _ entry: Entry) -> Bool {
        unique((result?.partitions ?? []) + Array(config.rows.prefix(entry.depth))).allSatisfy {
            row[$0] == entry.row[$0]
        }
    }
    private func expansion(key: String, label: String, columns: Bool) -> some View {
        let open = (columns ? expandedColumns : expandedRows).contains(key)
        return Button {
            if columns {
                if !expandedColumns.insert(key).inserted { expandedColumns.remove(key) }
            } else {
                if !expandedRows.insert(key).inserted { expandedRows.remove(key) }
            }
        } label: {
            Image(systemName: open ? "minus" : "plus")
        }
        .buttonStyle(.vision(.ghost, size: .iconXs)).accessibilityLabel(
            strings.t(open ? "analysis.ext.pivot.collapse" : "analysis.ext.pivot.expand", ["field": label]))
    }
    private func displayCell(_ row: AnalysisRow?, _ id: String) -> String {
        if percentages {
            guard let raw = row?["__percentages"]?[id], raw != .null,
                let value = raw.decimalValue
                    ?? raw.stringValue.flatMap({ Decimal(string: $0, locale: Locale(identifier: "en_US_POSIX")) })
            else { return "—" }
            return AnalysisPresentation.format(
                value: .number(value * 100), type: "decimal", id: id,
                numberFormat: shell.settings.numberFormat.rawValue, mode: .formatted, decimalPlaces: 2) + "%"
        }
        return AnalysisPresentation.format(
            value: row?[id], type: dataset.measures.first { $0.id == id }?.type ?? "decimal",
            id: id, numberFormat: shell.settings.numberFormat.rawValue)
    }
    private func unique(_ ids: [String]) -> [String] { ids.reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }
}
