import SwiftUI
import VisionNativeCore

struct AIInvestigationDocumentsView: View {
    let model: AIInvestigationModel
    let shell: NativeShellModel
    @State private var isExpanded = false
    @State private var pendingDelete: AIResearchDocument?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var calendar: Calendar { Calendar(identifier: .gregorian) }
    private var summary: String {
        let count = strings.t("aiResearch.documentCount", ["count": String(model.documents.count)])
        guard !model.dateFrom.isEmpty || !model.dateTo.isEmpty else { return count }
        return count + " · " + (model.dateFrom.isEmpty ? "…" : model.dateFrom) + " – "
            + (model.dateTo.isEmpty ? "…" : model.dateTo)
    }
    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Button(strings.t("aiResearch.addDocument"), systemImage: "paperclip") {
                        Task { await model.uploadPickedDocument() }
                    }.disabled(model.busy)
                    Text(strings.t("aiResearch.documentCount", ["count": String(model.documents.count)]))
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                }
                if !model.documents.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(model.documents, id: \.id) { document in
                            documentRow(document)
                            Divider()
                        }
                    }
                }
                Text(
                    strings.t(
                        "aiResearch.effectivePreferences",
                        [
                            "currency": model.resolvedCurrency,
                            "benchmark": model.resolvedBenchmark ?? strings.t("aiResearch.noBenchmark"),
                        ])
                )
                .font(.caption).foregroundStyle(theme.secondaryLabel)
                HStack(alignment: .top, spacing: 16) {
                    dateField(
                        "aiResearch.dateFrom", value: Binding(get: { model.dateFrom }, set: { model.dateFrom = $0 }))
                    dateField("aiResearch.dateTo", value: Binding(get: { model.dateTo }, set: { model.dateTo = $0 }))
                }
            }.padding(.top, 12)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("aiResearch.evidenceOptions")).font(.callout.weight(.medium))
                Text(summary).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }
        .padding(.vertical, 10)
        .alert(
            strings.t("aiResearch.deleteDocument"),
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            presenting: pendingDelete
        ) { document in
            Button(strings.t("common.cancel"), role: .cancel) { pendingDelete = nil }
            Button(strings.t("common.delete"), role: .destructive) {
                pendingDelete = nil
                Task { await model.deleteDocumentConfirmed(document.id) }
            }
        } message: { document in
            Text(strings.t("aiResearch.deleteDocumentConfirm", ["name": document.title]))
        }
    }
    private func documentRow(_ document: AIResearchDocument) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text").foregroundStyle(theme.secondaryLabel).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(document.title).font(.callout)
                Text(document.extractionStatus.rawValue).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            Spacer(minLength: 12)
            Button {
                pendingDelete = document
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless).foregroundStyle(theme.destructive)
            .accessibilityLabel(strings.t("aiResearch.deleteDocument") + ": " + document.title)
        }.padding(.vertical, 10)
    }
    private func dateField(_ key: String, value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(key)).font(.caption)
            VisionDateField(
                day: PlannedDay(ymd: value.wrappedValue, calendar: calendar), placeholder: strings.t(key),
                allowClear: true,
                settings: shell.settings, strings: strings, calendar: calendar,
                onChange: { value.wrappedValue = $0?.ymd ?? "" }
            )
            .accessibilityLabel(strings.t(key))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
