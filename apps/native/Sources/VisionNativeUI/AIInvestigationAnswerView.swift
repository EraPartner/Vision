import SwiftUI
import VisionNativeCore

struct AIInvestigationAnswerView: View {
    let answer: AIAnswer
    let shell: NativeShellModel
    @State private var selectedEvidenceID: String?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var selectedEvidence: AIEvidence? {
        answer.evidence.last { $0.id == selectedEvidenceID }
    }
    var body: some View {
        ResearchCard(padding: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(strings.t("aiResearch.status." + answer.status))
                Spacer(minLength: 12)
                Text(answer.language.uppercased() + " · " + answer.depth)
            }.font(.footnote).foregroundStyle(theme.secondaryLabel)
            Text(answer.summary).font(.body).textSelection(.enabled)
            statementSection("aiResearch.facts", statements: answer.facts)
            statementSection("aiResearch.calculations", statements: answer.calculations)
            statementSection("aiResearch.interpretations", statements: answer.interpretations)
            if !answer.assumptions.isEmpty {
                annotation("aiResearch.assumptions", lines: answer.assumptions, warning: false)
            }
            if !answer.missingInformation.isEmpty {
                annotation("aiResearch.missing", lines: answer.missingInformation, warning: true)
            }
            if let id = answer.analysisReference?["id"]?.stringValue {
                Button(strings.t("aiResearch.openAnalysis")) {
                    shell.navigate(
                        to: NativeRoute(path: "/analysis", query: [.init(name: "savedAnalysis", value: id)]).string)
                }.buttonStyle(.bordered).controlSize(.small)
            }
            if let evidence = selectedEvidence { evidenceDetail(evidence) }
        }
    }
    @ViewBuilder private func statementSection(_ key: String, statements: [AIAnswerStatement]) -> some View {
        if !statements.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t(key)).font(.headline).accessibilityAddTraits(.isHeader)
                ForEach(Array(statements.enumerated()), id: \.offset) { _, statement in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(statement.text).font(.body).textSelection(.enabled)
                            if !statement.evidenceIds.isEmpty {
                                ViewThatFits(in: .horizontal) {
                                    HStack(alignment: .top, spacing: 8) { evidenceButtons(statement.evidenceIds) }
                                    VStack(alignment: .leading, spacing: 6) { evidenceButtons(statement.evidenceIds) }
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
    private func evidenceButtons(_ ids: [String]) -> some View {
        ForEach(Array(ids.enumerated()), id: \.offset) { _, id in
            let evidence = answer.evidence.last { $0.id == id }
            Button(evidence?.label ?? id) { selectedEvidenceID = id }
                .buttonStyle(.visionLink).font(.caption).multilineTextAlignment(.leading)
                .help(evidence?.excerpt ?? "")
        }
    }
    private func annotation(_ key: String, lines: [String], warning: Bool) -> some View {
        (Text(strings.t(key) + ": ").fontWeight(.medium).foregroundStyle(warning ? theme.warning : theme.foreground)
            + Text(lines.joined(separator: "; ")))
            .font(.footnote).foregroundStyle(warning ? theme.warning : theme.secondaryLabel).textSelection(.enabled)
    }
    private func evidenceDetail(_ evidence: AIEvidence) -> some View {
        ResearchCard(padding: 16) {
            Text(evidence.label).font(.headline)
            if let excerpt = evidence.excerpt {
                Text(excerpt).font(.footnote).foregroundStyle(theme.secondaryLabel).textSelection(.enabled)
            }
            if evidence.kind == "web", evidence.locator.hasPrefix("https://"), let url = URL(string: evidence.locator) {
                Link(evidence.locator, destination: url).font(.caption).textSelection(.enabled)
            } else {
                Text(evidence.locator).font(.caption.monospaced()).foregroundStyle(theme.secondaryLabel).textSelection(
                    .enabled)
            }
        }
    }
}
