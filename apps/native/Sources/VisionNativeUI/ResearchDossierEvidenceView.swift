import SwiftUI
import VisionNativeCore

struct ResearchDossierEvidenceListView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        ResearchCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(shell.strings.t("dossiers.evidence")).font(.researchCardTitle)
                        .accessibilityAddTraits(.isHeader)
                    Text(shell.strings.t("dossiers.evidenceHint")).font(.callout).foregroundStyle(theme.secondaryLabel)
                }
                Spacer()
                Button(shell.strings.t("dossiers.addEvidence"), systemImage: "plus") { model.addEvidence() }
                    .buttonStyle(.vision(.outline, size: .sm)).disabled((model.draft?.evidence.count ?? 0) >= 30)
            }
            ForEach(Array((model.draft?.evidence ?? []).enumerated()), id: \.element.id) { index, item in
                if index > 0 { Divider() }
                ResearchDossierEvidenceView(model: model, evidenceId: item.id, index: index, shell: shell)
            }
        }
    }
}

struct ResearchDossierEvidenceView: View {
    let model: ResearchDossiersModel
    let evidenceId: ResearchDossierEvidenceID
    let index: Int
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var item: ResearchDossierEvidence? { model.draft?.evidence.first { $0.id == evidenceId } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(
                    strings.t("dossiers.evidenceNumber", ["number": String(index + 1)]) + " · "
                        + strings.t("dossiers.origin." + (item?.origin ?? .user).rawValue)
                )
                .font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                Button(strings.t("dossiers.removeEvidence"), systemImage: "trash", role: .destructive) {
                    model.removeEvidence(evidenceId)
                }.buttonStyle(.vision(.ghost, size: .sm))
            }
            HStack(alignment: .top, spacing: 16) {
                ResearchDossierField(label: strings.t("dossiers.field.origin")) {
                    VisionSegmentedControl(
                        selection: choice(\.origin, fallback: .user), values: ResearchDossierOrigin.allCases,
                        title: { strings.t("dossiers.origin." + $0.rawValue) }
                    ).accessibilityLabel(strings.t("dossiers.field.origin"))
                }
                ResearchDossierField(label: strings.t("dossiers.field.stance")) {
                    VisionSegmentedControl(
                        selection: choice(\.stance, fallback: .context), values: ResearchDossierStance.allCases,
                        title: { strings.t("dossiers.stance." + $0.rawValue) }
                    ).accessibilityLabel(strings.t("dossiers.field.stance"))
                }
            }
            area("dossiers.field.claim", \.claim)
            ResearchDossierField(label: strings.t("dossiers.field.document")) {
                VisionSelect(
                    selection: Binding(
                        get: { item?.source.documentId },
                        set: { model.updateSourceDocument(evidenceId: evidenceId, documentId: $0) }),
                    options: documentOptions, accessibilityLabel: strings.t("dossiers.field.document"), expands: true)
                if model.pickerErrors["documents"] != nil {
                    Text(strings.t("dossiers.documentsError")).font(.caption).foregroundStyle(theme.destructive)
                }
                if let id = item?.source.documentId, !model.documents.contains(where: { $0.id == id }) {
                    Text(strings.t("dossiers.documentUnavailable")).font(.caption).foregroundStyle(theme.warning)
                }
            }
            HStack(alignment: .top, spacing: 16) {
                sourceText("dossiers.field.sourceTitle", \.source.title)
                sourceText("dossiers.field.sourceReference", \.source.reference)
            }
            HStack(alignment: .top, spacing: 16) {
                ResearchDossierField(label: strings.t("dossiers.field.sourceDate")) {
                    VisionDateField(
                        day: PlannedDay(ymd: item?.source.sourceDate, calendar: .current), placeholder: "",
                        allowClear: true,
                        settings: shell.settings, strings: strings, calendar: .current
                    ) { day in
                        mutate { $0.source.sourceDate = day?.ymd }
                    }.submitScope()
                }
                ResearchDossierField(label: strings.t("dossiers.field.accessedAt")) {
                    ResearchDossierAccessedAtField(
                        value: item?.source.accessedAt, label: strings.t("dossiers.field.accessedAt"), shell: shell
                    ) {
                        model.setAccessedAt(evidenceId: evidenceId, localValue: $0)
                    }.submitScope()
                }
            }
            area("dossiers.field.notes", \.notes)
            if let source = item?.source, source.documentId != nil || source.contentSha256 != nil {
                Text(
                    strings.t(
                        "dossiers.documentAnchor",
                        [
                            "id": source.documentId?.rawValue ?? "—", "version": source.documentVersion.map(String.init) ?? "—",
                            "passage": source.passageOrdinal.map(String.init) ?? "—",
                            "hash": source.contentSha256 ?? "—",
                        ])
                )
                .font(.caption).foregroundStyle(theme.tertiaryLabel).textSelection(.enabled)
            }
        }.accessibilityElement(children: .contain)
    }
    private var documentOptions: [VisionSelectOption<ResearchDocumentID?>] {
        var options = [VisionSelectOption<ResearchDocumentID?>(value: nil, title: strings.t("dossiers.noDocument"))]
        if let id = item?.source.documentId, !model.readyDocuments.contains(where: { $0.id == id }) {
            // Keep the stored pin visible without treating an unready document as selectable.
            options.append(
                VisionSelectOption<ResearchDocumentID?>(
                    value: Optional(id),
                    title: model.documents.first(where: { $0.id == id })?.title
                        ?? strings.t("dossiers.documentUnavailable"), isDisabled: true))
        }
        options += model.readyDocuments.map { VisionSelectOption<ResearchDocumentID?>(value: Optional($0.id), title: $0.title) }
        return options
    }
    private func mutate(_ edit: (inout ResearchDossierEvidence) -> Void) {
        guard let index = model.draft?.evidence.firstIndex(where: { $0.id == evidenceId }) else { return }
        if var draft = model.draft {
            edit(&draft.evidence[index])
            model.draft = draft
        }
    }
    private func choice<Value>(_ path: WritableKeyPath<ResearchDossierEvidence, Value>, fallback: Value) -> Binding<Value> {
        Binding(get: { item?[keyPath: path] ?? fallback }, set: { value in mutate { $0[keyPath: path] = value } })
    }
    private func text(_ path: WritableKeyPath<ResearchDossierEvidence, String>) -> Binding<String> {
        Binding(get: { item?[keyPath: path] ?? "" }, set: { value in mutate { $0[keyPath: path] = value } })
    }
    private func area(_ key: String, _ path: WritableKeyPath<ResearchDossierEvidence, String>) -> some View {
        ResearchDossierField(label: strings.t(key)) { ResearchDossierTextArea(text: text(path), label: strings.t(key)) }
    }
    private func sourceText(_ key: String, _ path: WritableKeyPath<ResearchDossierEvidence, String>) -> some View {
        ResearchDossierField(label: strings.t(key)) {
            TextField("", text: text(path)).textFieldStyle(.vision).accessibilityLabel(strings.t(key))
        }
    }
}

struct ResearchDossierAccessedAtField: View {
    let value: String?
    let label: String
    let shell: NativeShellModel
    let change: (String) -> Void
    @State private var isOpen = false
    @Environment(\.visionTheme) private var theme
    var body: some View {
        HStack(spacing: 6) {
            Button {
                isOpen = true
            } label: {
                HStack {
                    Image(systemName: "calendar").foregroundStyle(theme.secondaryLabel)
                    Text(ResearchDossierDateDisplay.localPrefix(value)).monospacedDigit()
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.visionOutline).accessibilityLabel(label)
                .popover(isPresented: $isOpen) {
                    DatePicker(
                        label,
                        selection: Binding(
                            get: {
                                ResearchDossierDateDisplay.localDate(value) ?? Date()
                            }, set: { change(ResearchDossierDateDisplay.localValue($0)) }),
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .datePickerStyle(.compact).padding(20)
                }
            if value != nil {
                Button {
                    change("")
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.plain).foregroundStyle(theme.secondaryLabel).accessibilityLabel(
                    shell.strings.t("common.clear"))
            }
        }
    }
}
