import SwiftUI
import VisionNativeCore

struct AIInvestigationHistoryView: View {
    let model: AIInvestigationModel
    let shell: NativeShellModel
    @State private var isExpanded = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        DisclosureGroup(strings.t("aiResearch.disclosureHistory"), isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 14) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { actions }
                    VStack(alignment: .leading, spacing: 10) { actions }
                }
                if !model.disclosureGrants.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(model.disclosureGrants.enumerated()), id: \.offset) { _, grant in
                            HStack(spacing: 12) {
                                Text(
                                    AIInvestigationJSON.string(grant["mode"]) + " · "
                                        + AIInvestigationJSON.string(grant["id"])
                                )
                                .font(.caption.monospaced()).textSelection(.enabled)
                                Spacer(minLength: 12)
                                if !AIInvestigationJSON.truthy(grant["revoked_at"]) {
                                    Button(strings.t("aiResearch.revoke")) {
                                        Task { await model.revokeGrant(AIInvestigationJSON.string(grant["id"])) }
                                    }
                                }
                            }.padding(.vertical, 10)
                            Divider()
                        }
                    }
                }
                ForEach(Array(model.disclosureRecords.enumerated()), id: \.offset) { _, record in
                    AIInvestigationJSONBlock(value: record)
                }
            }.padding(.top, 12)
        }.font(.callout).padding(.vertical, 10)
    }
    @ViewBuilder private var actions: some View {
        Button(
            model.recordCount.map { strings.t("aiResearch.recordCount", ["count": String($0)]) }
                ?? strings.t("aiResearch.inspectRecords")
        ) {
            Task { await model.loadHistory() }
        }.buttonStyle(.visionOutline)
        if model.recordCount != nil {
            Button(strings.t("aiResearch.deleteRecords"), role: .destructive) { Task { await model.deleteHistory() } }
        }
    }
}

struct AIInvestigationJSONBlock: View {
    let value: TaxValue
    @Environment(\.visionTheme) private var theme
    private var text: String { AIInvestigationJSON.pretty(value) }
    private var height: CGFloat {
        min(160, max(48, CGFloat(text.split(separator: "\n", omittingEmptySubsequences: false).count) * 16 + 24))
    }
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text).font(.caption.monospaced()).textSelection(.enabled).padding(12)
        }.frame(height: height).frame(maxWidth: .infinity, alignment: .leading).background(
            theme.background, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
        )
        .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border.opacity(0.6)))
    }
}

private enum AIInvestigationJSON {
    static func pretty(_ value: TaxValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
    static func string(_ value: TaxValue?) -> String {
        guard let value else { return "undefined" }
        switch value {
        case .string(let text): return text
        case .null: return "null"
        case .number(let number): return VisionFormat.plain(number)
        case .bool(let flag): return flag ? "true" : "false"
        default: return pretty(value)
        }
    }
    static func truthy(_ value: TaxValue?) -> Bool {
        guard let value else { return false }
        switch value {
        case .null: return false
        case .bool(let flag): return flag
        case .number(let number): return !number.isZero && !number.isNaN
        case .string(let text): return !text.isEmpty
        default: return true
        }
    }
}
