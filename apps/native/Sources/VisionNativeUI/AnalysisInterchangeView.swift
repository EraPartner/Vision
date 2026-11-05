import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore

public struct AnalysisInterchangeView: View {
    let model: AnalysisWorkspaceModel
    let shell: NativeShellModel
    @State private var csvPicker = false
    @State private var workbookPicker = false
    @State private var localError: String?
    @State private var joinColumns: [String: String] = [:]
    @State private var previews: Set<String> = []
    @Environment(\.visionTheme) private var theme
    public init(model: AnalysisWorkspaceModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var attachments: [AnalysisAttachment] {
        (model.scenarioModel["attachments"]?.arrayValue ?? []).compactMap { try? AnalysisAttachment(raw: $0) }
    }
    private var columns: [AnalysisColumn] { model.displayedResult?.effectiveColumns ?? [] }
    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.displayedResult != nil && !model.canExport {
                Text(strings.t("analysis.exportNeedsRun")).foregroundStyle(theme.secondaryLabel)
            }
            HStack {
                Button(strings.t("analysis.ext.workbook.export"), systemImage: "tablecells") {
                    Task { await model.export(format: "xlsx") }
                }
                .disabled(!model.canExport)
                Button(strings.t("analysis.ext.workbook.import"), systemImage: "square.and.arrow.up") {
                    openPicker(workbook: true)
                }
                .fileImporter(
                    isPresented: $workbookPicker, allowedContentTypes: [UTType(filenameExtension: "xlsx") ?? .data],
                    allowsMultipleSelection: false
                ) {
                    selected($0, format: "xlsx")
                }
                Button(strings.t("analysis.exportCsv"), systemImage: "square.and.arrow.down") {
                    Task { await model.export(format: "csv") }
                }
                .disabled(!model.canExport)
                Button(strings.t("analysis.attachScenarioCsv"), systemImage: "paperclip") {
                    openPicker(workbook: false)
                }
                .fileImporter(
                    isPresented: $csvPicker, allowedContentTypes: [.commaSeparatedText], allowsMultipleSelection: false
                ) {
                    selected($0, format: "csv")
                }
                if model.isInterchangeBusy { ProgressView().controlSize(.small) }
            }.buttonStyle(.visionOutline).controlSize(.small).disabled(model.isInterchangeBusy)
            Text(strings.t("analysis.ext.workbook.scope")).font(.caption).foregroundStyle(theme.secondaryLabel)
            Text(strings.t("analysis.csvSafety")).font(.caption).foregroundStyle(theme.secondaryLabel)
            if let error = localError ?? model.interchangeError {
                Text(verbatim: error).foregroundStyle(theme.destructive).textSelection(.enabled)
            }
            ForEach(attachments) { attachment in attachmentView(attachment) }
        }
    }
    private func openPicker(workbook: Bool) {
        guard (model.scenarioModel["attachments"]?.arrayValue?.count ?? 0) < 5 else {
            localError = strings.t("analysis.ext.workbook.limit")
            return
        }
        localError = nil
        if workbook { workbookPicker = true } else { csvPicker = true }
    }
    private func selected(_ selection: Result<[URL], Error>, format: String) {
        guard case .success(let urls) = selection, let url = urls.first else { return }
        Task {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try await Task.detached { try Data(contentsOf: url, options: .mappedIfSafe) }.value
                guard data.count <= (format == "csv" ? 1_000_000 : 10_000_000) else {
                    localError = strings.t("analysis.ext.workbook.limit")
                    return
                }
                localError = nil
                await model.importAttachment(file: .init(name: url.lastPathComponent, data: data), format: format)
            } catch { localError = error.localizedDescription }
        }
    }
    private func attachmentView(_ attachment: AnalysisAttachment) -> some View {
        let joined = (model.scenarioModel["joins"]?.arrayValue ?? []).first { $0["inputId"] == .string(attachment.id) }
        let resultColumn =
            joinColumns[attachment.id + ":result"] ?? joined?["resultColumn"]?.stringValue ?? columns.first?.id ?? ""
        let inputColumn =
            joinColumns[attachment.id + ":input"] ?? joined?["inputColumn"]?.stringValue ?? attachment.columns.first?.id
            ?? ""
        return AnalysisPanel {
            HStack(alignment: .top) {
                Text("\(attachment.fileName) · \(attachment.rows.count) \(strings.t("analysis.rows"))").font(.headline)
                Spacer()
                Button(role: .destructive) {
                    model.removeAttachment(id: attachment.id)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.vision(.ghost, size: .iconSm))
                .accessibilityLabel(strings.t("analysis.removeScenario"))
            }
            DisclosureGroup(
                strings.t("analysis.ext.workbook.preview"),
                isExpanded: Binding(
                    get: { previews.contains(attachment.id) },
                    set: {
                        if $0 { previews.insert(attachment.id) } else { previews.remove(attachment.id) }
                    })
            ) {
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            ForEach(attachment.columns) { Text("\($0.label) (\($0.type))") }
                        }.fontWeight(.medium)
                        ForEach(Array(attachment.rows.prefix(5).enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(attachment.columns) { Text(verbatim: AnalysisPresentation.rawText(row[$0.id])) }
                            }
                        }
                    }.font(.caption).monospacedDigit().textSelection(.enabled).padding(.top, 8)
                }
            }
            HStack(alignment: .top, spacing: 12) {
                joinSelect(
                    "analysis.interchange.resultField", selection: resultColumn, options: resultOptions,
                    set: { joinColumns[attachment.id + ":result"] = $0 })
                joinSelect(
                    "analysis.interchange.importedField", selection: inputColumn,
                    options: attachment.columns.map { VisionSelectOption(value: $0.id, title: $0.label) },
                    set: { joinColumns[attachment.id + ":input"] = $0 })
            }
            Text(strings.t("analysis.interchange.matchHint")).font(.caption).foregroundStyle(theme.secondaryLabel)
            Button(strings.t(joined != nil ? "analysis.updateScenarioJoin" : "analysis.addScenarioJoin")) {
                var joins = model.scenarioModel["joins"]?.arrayValue ?? []
                joins.removeAll { $0["inputId"] == .string(attachment.id) }
                joins.append(
                    .object([
                        "inputId": .string(attachment.id), "resultColumn": .string(resultColumn),
                        "inputColumn": .string(inputColumn),
                    ]))
                model.scenarioModel["joins"] = .array(joins)
            }.buttonStyle(.visionOutline).disabled(resultColumn.isEmpty || inputColumn.isEmpty)
        }
    }
    private var resultOptions: [VisionSelectOption<String>] {
        var options: [VisionSelectOption<String>] = []
        if columns.isEmpty { options.append(VisionSelectOption(value: "", title: "—")) }
        for column in columns { options.append(VisionSelectOption(value: column.id, title: column.label ?? column.id)) }
        return options
    }
    private func joinSelect(
        _ key: String, selection: String, options: [VisionSelectOption<String>], set: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(key)).font(.callout)
            VisionSelect(
                selection: Binding(get: { selection }, set: set), options: options,
                accessibilityLabel: strings.t(key), expands: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
