import SwiftUI
import VisionNativeCore

struct ResearchDossierEditorView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var heading: String {
        let title = model.draft?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? strings.t("dossiers.new") : title
    }
    var body: some View {
        ResearchCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(heading)
                        .font(.researchCardTitle).lineLimit(1).accessibilityAddTraits(.isHeader)
                    if let detail = model.detail, model.selectedId != nil {
                        Text(
                            strings.t("dossiers.workspace." + detail.workspace.rawValue) + " · "
                                + strings.t("dossiers.version", ["version": String(detail.version)])
                        )
                        .foregroundStyle(theme.secondaryLabel)
                    }
                }
                Spacer()
                if model.selectedId != nil {
                    Menu {
                        Button(strings.t("dossiers.exportOne"), systemImage: "arrow.down.doc") {
                            Task { await model.exportOne() }
                        }
                        Divider()
                        Button(strings.t("dossiers.delete"), systemImage: "trash", role: .destructive) {
                            model.requestDelete()
                        }.disabled(model.busy)
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuStyle(.button).buttonStyle(.vision(.outline, size: .icon)).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel(strings.t("dossiers.editorMenu"))
                }
                Button(strings.t("dossiers.save"), systemImage: "square.and.arrow.down") { Task { await model.save() } }
                    .buttonStyle(.visionPrimary).disabled(model.busy)
            }
            HStack(alignment: .top, spacing: 16) {
                ResearchDossierField(label: strings.t("dossiers.field.title")) {
                    TextField("", text: text(\.title)).textFieldStyle(.vision).accessibilityLabel(
                        strings.t("dossiers.field.title")
                    )
                }
                ResearchDossierField(label: strings.t("dossiers.field.workspace")) {
                    VisionSelect(
                        selection: choice(\.workspace, fallback: .research),
                        options: ResearchDossierContent.workspaces.map {
                            VisionSelectOption(value: $0, title: strings.t("dossiers.workspace." + $0.rawValue))
                        }, accessibilityLabel: strings.t("dossiers.field.workspace"), expands: true)
                }
            }
            area("dossiers.field.question", \.question)
            area("dossiers.field.thesis", \.userThesis)
            HStack(alignment: .top, spacing: 16) {
                lines("dossiers.field.assumptions", \.assumptions, .assumptions)
                lines("dossiers.field.openQuestions", \.openQuestions, .openQuestions)
            }
            area("dossiers.field.conclusion", \.conclusion, height: 120)
            ResearchDossierField(label: strings.t("dossiers.field.reviewDate")) {
                VisionDateField(
                    day: PlannedDay(ymd: model.draft?.reviewDate, calendar: .current), placeholder: "",
                    allowClear: true,
                    settings: shell.settings, strings: strings, calendar: .current
                ) { model.draft?.reviewDate = $0?.ymd }.submitScope()
            }.frame(maxWidth: 280)
        }
    }
    private func choice<Value>(_ path: WritableKeyPath<ResearchDossierContent, Value>, fallback: Value) -> Binding<Value> {
        Binding(get: { model.draft?[keyPath: path] ?? fallback }, set: { model.draft?[keyPath: path] = $0 })
    }
    private func text(_ path: WritableKeyPath<ResearchDossierContent, String>) -> Binding<String> {
        Binding(get: { model.draft?[keyPath: path] ?? "" }, set: { model.draft?[keyPath: path] = $0 })
    }
    private func area(_ key: String, _ path: WritableKeyPath<ResearchDossierContent, String>,
        height: CGFloat = VisionControlMetrics.textAreaMinHeight)
        -> some View
    {
        ResearchDossierField(label: strings.t(key)) {
            ResearchDossierTextArea(text: text(path), label: strings.t(key), height: height)
        }
    }
    private func lines(
        _ key: String, _ path: WritableKeyPath<ResearchDossierContent, [String]>, _ field: ResearchDossierLinesField
    ) -> some View {
        ResearchDossierField(label: strings.t(key)) {
            ResearchDossierTextArea(
                text: Binding(
                    get: { model.draft?[keyPath: path].joined(separator: "\n") ?? "" },
                    set: {
                        model.setLines(field, raw: $0)
                    }), label: strings.t(key), height: 80)
        }
    }
}

struct ResearchDossierField<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.medium))
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct ResearchDossierTextArea: View {
    @Binding var text: String
    let label: String
    /// `Textarea`: `min-h-20`; `rows={5}` on the conclusion.
    var height: CGFloat = VisionControlMetrics.textAreaMinHeight
    @FocusState private var focused: Bool
    var body: some View {
        TextEditor(text: $text).focused($focused).visionTextEditor(isFocused: focused, minHeight: height)
            .frame(height: height).accessibilityLabel(label)
    }
}
