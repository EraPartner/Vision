import SwiftUI
import VisionNativeCore

struct ResearchDossierLinksView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        ResearchCard(title: strings.t("dossiers.links")) {
            Text(strings.t("dossiers.linksHint")).font(.callout).foregroundStyle(theme.secondaryLabel)
            ForEach(model.detail?.linkDetails.filter { $0.status == "deleted" } ?? []) { item in
                ResearchDossierMessage(
                    text: strings.t("dossiers.deletedLink", ["label": item.labelSnapshot, "id": item.historicalId]),
                    kind: .info
                ) {}
            }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    categories.frame(minWidth: 180)
                    investments.frame(minWidth: 180)
                    analyses.frame(minWidth: 180)
                }
                VStack(alignment: .leading, spacing: 12) {
                    categories
                    investments
                    analyses
                }
            }
        }
    }
    private var categories: some View {
        ResearchDossierLinkPicker(
            label: strings.t("dossiers.linkCategories"), items: model.categories,
            selected: (model.draft?.links.categoryIds ?? []).map(String.init),
            hasError: model.pickerErrors["categories"] != nil, shell: shell
        ) {
            model.toggleLink(.categoryIds, id: $0)
        }
    }
    private var investments: some View {
        ResearchDossierLinkPicker(
            label: strings.t("dossiers.linkInvestments"), items: model.investments,
            selected: (model.draft?.links.investmentIds ?? []).map(String.init),
            hasError: model.pickerErrors["investments"] != nil, shell: shell
        ) {
            model.toggleLink(.investmentIds, id: $0)
        }
    }
    private var analyses: some View {
        ResearchDossierLinkPicker(
            label: strings.t("dossiers.linkAnalyses"), items: model.analyses,
            selected: model.draft?.links.savedAnalysisIds ?? [], hasError: model.pickerErrors["analyses"] != nil,
            shell: shell
        ) {
            model.toggleLink(.savedAnalysisIds, id: $0)
        }
    }
}

struct ResearchDossierLinkPicker: View {
    let label: String
    let items: [ResearchDossierPickerItem]
    let selected: [String]
    let hasError: Bool
    let shell: NativeShellModel
    let toggle: (String) -> Void
    @State private var query = ""
    @State private var isExpanded = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var visible: [ResearchDossierPickerItem] {
        let filter = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(with: .current)
        return items.filter { $0.label.lowercased(with: .current).contains(filter) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if hasError { Text(strings.t("dossiers.linksError")).font(.caption).foregroundStyle(theme.destructive) }
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 10) {
                    if items.count > 8 {
                        TextField(strings.t("dossiers.searchLinks", ["type": label]), text: $query)
                            .textFieldStyle(.vision).accessibilityLabel(
                                strings.t("dossiers.searchLinks", ["type": label]))
                    }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(visible) { item in
                                Toggle(
                                    item.label,
                                    isOn: Binding(get: { selected.contains(item.id) }, set: { _ in toggle(item.id) })
                                )
                                .toggleStyle(.checkbox).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if !hasError && visible.isEmpty {
                                Text(strings.t("dossiers.noMatchingLinks")).font(.caption).foregroundStyle(
                                    theme.secondaryLabel)
                            }
                        }.padding(.vertical, 5)
                    }.frame(maxHeight: 224)
                }.padding(.top, 8)
            } label: {
                HStack(spacing: 6) {
                    Text(label).font(.callout.weight(.medium))
                    Text(strings.t("dossiers.linksSelected", ["count": String(selected.count)])).font(.caption)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }.padding(12).background(theme.foreground.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ResearchDossierHistoryView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        ResearchCard(title: strings.t("dossiers.history")) {
            if model.historyLoading { ProgressView().accessibilityLabel(strings.t("common.loading")) }
            if model.historyError != nil {
                ResearchDossierMessage(text: strings.t("dossiers.historyError"), kind: .error) {}
            }
            ForEach(model.history) { version in
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(
                            strings.t("dossiers.version", ["version": String(version.version)]) + " · "
                                + timestamp(version.createdAt)
                        )
                        .font(.callout.weight(.medium))
                        Text(
                            version.snapshot.conclusion.isEmpty
                                ? strings.t("dossiers.noConclusion") : version.snapshot.conclusion
                        )
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                    Spacer()
                    Button(strings.t("dossiers.restore"), systemImage: "arrow.counterclockwise") {
                        model.requestRestore(version.version)
                    }
                    .disabled(model.busy || version.version == model.detail?.version)
                }.padding(.vertical, 6)
                if version.version != model.history.last?.version { Divider() }
            }
        }
    }
    private func timestamp(_ text: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
        guard let date else { return text }
        // Version history uses host locale/timezone, independently of the app date setting.
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = .current
        formatter.setLocalizedDateFormatFromTemplate("yMdjms")
        return formatter.string(from: date)
    }
}
