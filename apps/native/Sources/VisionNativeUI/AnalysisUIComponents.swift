import SwiftUI
import VisionNativeCore

struct AnalysisPanel<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title { Text(title).font(.headline).accessibilityAddTraits(.isHeader) }
            if let description { Text(description).font(.callout).foregroundStyle(theme.secondaryLabel) }
            content()
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground()
    }
}

enum AnalysisSourceLabels {
    private static let keys: [String: String] = [
        "Transactions": "analysis.catalog.Transactions", "Accounts": "analysis.catalog.Accounts",
        "Holding events": "analysis.catalog.Holding_events", "Cash flows": "analysis.catalog.Cash_flows",
        "Transaction ID": "analysis.catalog.Transaction_ID", "Date": "analysis.catalog.Date",
        "Month": "analysis.catalog.Month", "Amount": "analysis.catalog.Amount", "Currency": "analysis.catalog.Currency",
        "Account ID": "analysis.catalog.Account_ID", "Account": "analysis.catalog.Account",
        "Recipient": "analysis.catalog.Recipient", "Category": "analysis.catalog.Category",
        "Category detail": "analysis.catalog.Category_detail", "Category path": "analysis.catalog.Category_path",
        "Category path segments": "analysis.catalog.Category_path_segments",
        "Category path IDs": "analysis.catalog.Category_path_IDs",
        "Memo": "analysis.catalog.Memo", "Comment": "analysis.catalog.Comment", "Transfer": "analysis.catalog.Transfer",
        "Active": "analysis.catalog.Active", "Account display name": "analysis.catalog.Account_display_name",
        "Account institution": "analysis.catalog.Account_institution",
        "Transaction count": "analysis.catalog.Transaction_count",
        "Net amount": "analysis.catalog.Net_amount", "Display name": "analysis.catalog.Display_name",
        "Institution": "analysis.catalog.Institution", "Account type": "analysis.catalog.Account_type",
        "Owner": "analysis.catalog.Owner", "Account count": "analysis.catalog.Account_count",
        "Event ID": "analysis.catalog.Event_ID", "Investment": "analysis.catalog.Investment",
        "Symbol": "analysis.catalog.Symbol", "Asset class": "analysis.catalog.Asset_class",
        "Event type": "analysis.catalog.Event_type", "Units": "analysis.catalog.Units",
        "Event count": "analysis.catalog.Event_count",
        "Raw event amount total": "analysis.catalog.Raw_event_amount_total",
        "Raw event units total": "analysis.catalog.Raw_event_units_total",
        "Investment ID": "analysis.catalog.Investment_ID",
        "Cash-flow ID": "analysis.catalog.Cash_flow_ID", "Signed amount": "analysis.catalog.Signed_amount",
        "Spending": "analysis.catalog.Spending", "Income and refunds": "analysis.catalog.Income_and_refunds",
        "Flow type": "analysis.catalog.Flow_type", "Cash-flow count": "analysis.catalog.Cash_flow_count",
        "Net cash flow": "analysis.catalog.Net_cash_flow",
    ]
    /// Catalog labels have existing EN/NL keys; unknown labels remain server/user content.
    static func catalog(_ label: String, strings: any Localizing) -> String {
        keys[label].map { strings.t($0) } ?? label
    }
}

struct AnalysisCodeText: View {
    let text: String
    @Environment(\.visionTheme) private var theme
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text).font(.caption.monospaced()).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
        }.frame(maxHeight: 260)
            .background(theme.foreground.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.border.opacity(0.6)))
    }
}
