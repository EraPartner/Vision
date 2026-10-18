import SwiftUI
import VisionNativeCore

struct AnalysisQueryBuilderView: View {
    let model: AnalysisWorkspaceModel
    let shell: NativeShellModel
    @State private var fieldSearch = ""
    @State private var technicalFields = false
    @State private var advanced = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var dataset: AnalysisDataset? { model.datasets.first { $0.id == model.plan.datasetId } }
    private let operators = [
        "eq", "neq", "lt", "lte", "gt", "gte", "contains", "starts-with", "is-null", "is-not-null",
    ]

    init(model: AnalysisWorkspaceModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Picker(
                    strings.t("analysis.mode"),
                    selection: Binding(get: { model.mode }, set: { value in model.setMode(value) })
                ) {
                    Text(strings.t("analysis.visual")).tag(AnalysisMode.visual)
                    Text(strings.t("analysis.sql")).tag(AnalysisMode.sql)
                }.pickerStyle(.segmented)
                Picker(
                    strings.t("analysis.workspace"),
                    selection: Binding(get: { model.workspace }, set: { model.workspace = $0 })
                ) {
                    ForEach(AnalysisWorkspace.allCases, id: \.self) { workspace in
                        Text(strings.t("analysis.workspace." + workspace.rawValue)).tag(workspace)
                    }
                }
            }
            if let error = model.catalogError {
                Text(strings.t("analysis.catalogError")).font(.headline)
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await model.load(force: true, route: shell.route) } }
            } else if model.catalog == nil {
                ProgressView(strings.t("analysis.catalogLoading")).frame(maxWidth: .infinity).padding(30)
            } else if model.datasets.isEmpty {
                Text(strings.t("analysis.catalogEmpty")).foregroundStyle(theme.secondaryLabel)
            } else if model.mode == .sql {
                AnalysisSQLEditorView(model: model, shell: shell)
            } else if let dataset {
                visual(dataset)
            }
        }
    }

    private func visual(_ dataset: AnalysisDataset) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Picker(
                strings.t("analysis.dataset"),
                selection: Binding(get: { model.plan.datasetId }, set: { value in model.selectDataset(value) })
            ) {
                ForEach(model.datasets) { entry in Text(label(entry.label)).tag(entry.id) }
            }
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 290), alignment: .leading)], alignment: .leading, spacing: 24
            ) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(strings.t("analysis.fields")).font(.callout.weight(.medium))
                    Text(strings.t("analysis.fieldsHelp")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    TextField(strings.t("analysis.searchFields"), text: $fieldSearch).textFieldStyle(.roundedBorder)
                    Toggle(strings.t("analysis.technicalFields"), isOn: $technicalFields).font(.footnote)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(dataset.fields.filter(visible)) { field in
                                Toggle(
                                    label(field.label ?? field.id),
                                    isOn: Binding(
                                        get: { model.plan.fields.contains(field.id) },
                                        set: { model.toggleField(field.id, $0) }))
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 220)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text(strings.t("analysis.measures")).font(.callout.weight(.medium))
                    Text(strings.t("analysis.measuresHelp")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    ForEach(dataset.measures) { measure in
                        Toggle(
                            label(measure.label ?? measure.id),
                            isOn: Binding(
                                get: { model.plan.measures.contains(measure.id) },
                                set: { model.toggleMeasure(measure.id, $0) }))
                    }
                    DisclosureGroup(strings.t("analysis.advanced"), isExpanded: $advanced) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(dataset.joins) { join in
                                Toggle(
                                    strings.t("analysis.safeAccountJoin"),
                                    isOn: Binding(
                                        get: { model.plan.joins.contains(join.id) },
                                        set: { model.toggleJoin(join.id, $0) }))
                            }
                        }.padding(.top, 8)
                    }
                }.frame(maxHeight: .infinity, alignment: .top)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("analysis.groups")).font(.callout.weight(.medium))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), alignment: .leading)], alignment: .leading) {
                    ForEach(model.plan.fields, id: \.self) { id in
                        Toggle(
                            dataset.fields.first { $0.id == id }.map { label($0.label ?? $0.id) } ?? id,
                            isOn: Binding(
                                get: { model.plan.groups.contains(id) }, set: { model.toggleGroup(id, $0) }))
                    }
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(strings.t("analysis.filters")).font(.callout.weight(.medium))
                    Spacer()
                    Button(strings.t("analysis.addFilter"), systemImage: "plus") { model.addFilter() }
                        .buttonStyle(.bordered).disabled(dataset.fields.isEmpty)
                }
                ForEach(Array(model.plan.filters.enumerated()), id: \.offset) { index, filter in
                    filterRow(filter, index: index, dataset: dataset)
                }
            }
        }
    }

    private func filterRow(_ filter: AnalysisFilter, index: Int, dataset: AnalysisDataset) -> some View {
        let field = dataset.fields.first { $0.id == filter.fieldId }
        let context = ["number": String(index + 1), "field": field.map { label($0.label ?? $0.id) } ?? filter.fieldId]
        return HStack(alignment: .top, spacing: 10) {
            Picker(
                strings.t("analysis.filterField", ["number": String(index + 1)]),
                selection: filterText(index, \.fieldId)
            ) {
                ForEach(dataset.fields) { field in Text(label(field.label ?? field.id)).tag(field.id) }
            }.labelsHidden().accessibilityLabel(strings.t("analysis.filterField", ["number": String(index + 1)]))
            Picker(strings.t("analysis.filterOperator", context), selection: filterText(index, \.operator)) {
                ForEach(operators, id: \.self) { item in Text(strings.t("analysis.operator." + item)).tag(item) }
            }.labelsHidden().accessibilityLabel(strings.t("analysis.filterOperator", context))
            Group {
                if field?.type == "boolean" {
                    Picker(strings.t("analysis.filterValue", context), selection: valueText(index)) {
                        Text("—").tag("")
                        Text(strings.t("common.yes")).tag("true")
                        Text(strings.t("common.no")).tag("false")
                    }.labelsHidden()
                } else {
                    TextField(strings.t("analysis.filterValue", context), text: valueText(index)).textFieldStyle(
                        .roundedBorder)
                }
            }.disabled(["is-null", "is-not-null"].contains(filter.operator))
                .accessibilityLabel(strings.t("analysis.filterValue", context))
            Button {
                if model.plan.filters.indices.contains(index) { model.plan.filters.remove(at: index) }
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless).accessibilityLabel(strings.t("analysis.removeFilterContext", context))
        }.accessibilityElement(children: .contain)
    }
    private func filterText(_ index: Int, _ path: WritableKeyPath<AnalysisFilter, String>) -> Binding<String> {
        Binding(
            get: { model.plan.filters.indices.contains(index) ? model.plan.filters[index][keyPath: path] : "" },
            set: { value in
                guard model.plan.filters.indices.contains(index) else { return }
                model.plan.filters[index][keyPath: path] = value
            })
    }
    private func valueText(_ index: Int) -> Binding<String> {
        Binding(
            get: {
                guard model.plan.filters.indices.contains(index), let value = model.plan.filters[index].value,
                    value != .null
                else { return "" }
                return AnalysisPresentation.rawText(value)
            }, set: { model.setFilterValue(index: index, text: $0) })
    }
    private func visible(_ field: AnalysisColumn) -> Bool {
        let selected = model.plan.fields.contains(field.id)
        let technical = field.id.range(of: #"(^|[_.])id$|_ids$|_segments$"#, options: .regularExpression) != nil
        return (technicalFields || selected || !technical)
            && (fieldSearch.isEmpty
                || (label(field.label ?? field.id) + " " + field.id).localizedCaseInsensitiveContains(fieldSearch))
    }
    private func label(_ value: String) -> String { AnalysisSourceLabels.catalog(value, strings: strings) }
}

struct AnalysisSQLEditorView: View {
    let model: AnalysisWorkspaceModel
    let shell: NativeShellModel
    @State private var historyOpen = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    init(model: AnalysisWorkspaceModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(strings.t("analysis.sqlEditor")).font(.callout.weight(.medium))
            TextEditor(text: Binding(get: { model.sql }, set: { model.sql = $0 }))
                .font(.body.monospaced()).frame(minHeight: 220)
                .accessibilityLabel(strings.t("analysis.sqlEditor"))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.border.opacity(0.6)))
            VStack(alignment: .leading, spacing: 10) {
                Text(strings.t("analysis.approvedDatasets")).font(.callout.weight(.medium))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), alignment: .leading)], alignment: .leading) {
                    ForEach(model.datasets) { dataset in
                        Toggle(
                            AnalysisSourceLabels.catalog(dataset.label, strings: strings),
                            isOn: Binding(
                                get: { model.sqlDatasets.contains(dataset.id) },
                                set: { chosen in
                                    if chosen && !model.sqlDatasets.contains(dataset.id) {
                                        model.sqlDatasets.append(dataset.id)
                                    }
                                    if !chosen { model.sqlDatasets.removeAll { $0 == dataset.id } }
                                }))
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), alignment: .leading)], alignment: .leading) {
                    ForEach(model.datasets.filter { model.sqlDatasets.contains($0.id) }) { dataset in
                        ForEach(Array(dataset.fields.prefix(12))) { field in
                            Button(field.id) {
                                model.sql += (model.sql.isEmpty || model.sql.hasSuffix(" ") ? "" : " ") + field.id
                            }.font(.caption.monospaced()).buttonStyle(.bordered)
                        }
                    }
                }
            }.padding(12).overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.border.opacity(0.6)))
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("analysis.sqlParameters")).font(.callout)
                TextField(
                    "[\"2026-01-01\", 100]", text: Binding(get: { model.sqlValues }, set: { model.sqlValues = $0 })
                )
                .font(.body.monospaced()).textFieldStyle(.roundedBorder)
                .accessibilityLabel(strings.t("analysis.sqlParameters"))
                Text(strings.t("analysis.sqlParametersHint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                Text(strings.t("analysis.sqlHint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            if !model.sqlHistory.isEmpty {
                DisclosureGroup(strings.t("analysis.queryHistory"), isExpanded: $historyOpen) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(model.sqlHistory.prefix(10).enumerated()), id: \.offset) { _, query in
                            Button {
                                model.sql = query
                            } label: {
                                Text(query).font(.caption.monospaced()).lineLimit(2).frame(
                                    maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.borderless).padding(.vertical, 4).help(query)
                        }
                    }.padding(.top, 8)
                }
            }
        }
    }
}
