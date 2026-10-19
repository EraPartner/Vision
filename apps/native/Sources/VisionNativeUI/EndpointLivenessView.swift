import SwiftUI
import VisionNativeCore

/// `/admin/endpoints` (apps/frontend/src/pages/admin/EndpointLivenessPage.tsx) in SwiftUI.
public struct EndpointLivenessView: View {
    private let model: EndpointLivenessModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: EndpointLivenessModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        AdminPage {
            AdminPageHeader(title: strings.t("admin.endpoints.title"), subtitle: strings.t("admin.endpoints.description"))
            AdminCard(padding: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 12) {
                        Text(strings.t("admin.endpoints.tableTitle"))
                            .font(Font.visionTitle3)
                            .accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 12)
                        TextField(strings.t("admin.endpoints.filterPlaceholder"), text: filter)
                            .textFieldStyle(.vision)
                            .frame(maxWidth: 256)
                            .accessibilityLabel(strings.t("admin.endpoints.filterPlaceholder"))
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 24)
                    .padding(.bottom, 16)
                    table
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
            }
        }
        .task { await model.appear() }
    }

    private var filter: Binding<String> {
        Binding(get: { model.filter }, set: { model.filter = $0 })
    }

    private var columns: [String] {
        [
            "admin.endpoints.colMethod", "admin.endpoints.colPath", "admin.endpoints.colRequests",
            "admin.endpoints.colErrors", "admin.endpoints.colErrorRate", "admin.endpoints.colP50",
            "admin.endpoints.colP95",
        ].map { strings.t($0) }
    }

    @ViewBuilder
    private var table: some View {
        let rows = model.filteredRows
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                    Text(column)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(theme.secondaryLabel)
                        .padding(.vertical, 8)
                        .gridColumnAlignment(index < 2 ? .leading : .trailing)
                        .accessibilityAddTraits(.isHeader)
                }
            }
            if model.isLoading {
                ForEach(0..<10, id: \.self) { _ in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(0..<7, id: \.self) { _ in SkeletonBar(width: 56, height: 14).padding(.vertical, 10) }
                    }
                }
            } else if !rows.isEmpty {
                ForEach(rows) { row in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    endpointRow(row)
                }
            }
        }
        if !model.isLoading && rows.isEmpty {
            VisionEmptyState(symbol: "dot.radiowaves.left.and.right", title: strings.t("admin.endpoints.noMatches")) {
                EmptyView()
            }
            .padding(.vertical, 24)
        }
    }

    private func methodColor(_ tone: EndpointRow.MethodTone) -> Color {
        switch tone {
        case .info: return theme.info
        case .success: return theme.success
        case .warning: return theme.warning
        case .destructive: return theme.destructive
        case .neutral: return theme.secondaryLabel
        }
    }

    private func rateColor(_ tone: EndpointRow.RateTone) -> Color {
        switch tone {
        case .secondary: return theme.secondaryLabel
        case .warning: return theme.warning
        case .destructive: return theme.destructive
        }
    }

    private func endpointRow(_ row: EndpointRow) -> GridRow<some View> {
        let tone = row.methodTone
        let neutral = tone == .neutral
        return GridRow {
            Text(row.method)
                .font(.caption.monospaced())
                .foregroundStyle(methodColor(tone))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                        .fill(neutral ? theme.foreground.opacity(0.06) : methodColor(tone).opacity(0.1)))
                .padding(.vertical, 8)
            Text(row.path)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
            Text(row.requests).monospacedDigit()
            Text(row.errors).monospacedDigit()
            Text(row.errorRate(locale: shell.settings.numberFormat.locale))
                .monospacedDigit()
                .fontWeight(row.rateTone == .destructive ? .medium : .regular)
                .foregroundStyle(rateColor(row.rateTone))
            Text(row.p50)
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
            Text(row.p95)
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
        }
    }
}
