import SwiftUI
import VisionNativeCore

/// `/admin/db` (apps/frontend/src/pages/DbMaintenancePage.tsx) in SwiftUI: the header with
/// More actions and Vacuum all tables, the two summary cards and the table statistics.
public struct DatabaseMaintenanceView: View {
    private let model: DatabaseMaintenanceModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: DatabaseMaintenanceModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        AdminPage {
            AdminPageHeader(title: strings.t("dbMaintenance.title"), subtitle: strings.t("dbMaintenance.subtitle")) {
                HStack(spacing: 8) {
                    moreActions
                    Button {
                        Task { await model.vacuum(table: nil, strings: strings) }
                    } label: {
                        Label(
                            model.isVacuumingAll ? strings.t("dbMaintenance.vacuuming") : strings.t("dbMaintenance.vacuumAll"),
                            systemImage: "bolt")
                    }
                    .buttonStyle(.visionPrimary)
                    .disabled(model.isVacuuming)
                }
            }
            summaryCards
            if let error = model.errorState(strings: strings) {
                AdminErrorBanner(state: error, strings: strings)
            }
            AdminCard(padding: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(strings.t("dbMaintenance.tableStats"))
                        .font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                        .padding(24)
                    table
                        .padding(.horizontal, 16)
                    Text(strings.t("dbMaintenance.statsNote"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                        .padding(.bottom, 20)
                }
            }
        }
        .task { await model.appear() }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: model.notice, strings: strings) { model.clearNotice($0) }
        }
    }

    /// `admin.moreActions`: Refresh, disabled while loading.
    private var moreActions: some View {
        Menu {
            Button {
                Task { await model.refresh() }
            } label: {
                Label(strings.t("dbMaintenance.refresh"), systemImage: "arrow.clockwise")
            }
            .disabled(model.isLoading)
        } label: {
            Image(systemName: model.isLoading ? "arrow.clockwise" : "ellipsis")
                .symbolEffect(.rotate, options: .repeat(.continuous), isActive: model.isLoading)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("admin.moreActions"))
        .visionTooltip(strings.t("admin.moreActions"))
    }

    // MARK: Summary cards

    private var summaryCards: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 16)], spacing: 16) {
            summaryCard(strings.t("dbMaintenance.totalSize"), value: model.totalSize, symbol: "internaldrive")
            summaryCard(
                strings.t("dbMaintenance.tableCount"), value: String(model.tableCount), symbol: "cylinder.split.1x2")
        }
    }

    private func summaryCard(_ label: String, value: String, symbol: String) -> some View {
        AdminCard(padding: 24) {
            HStack(spacing: 16) {
                AdminIconBadge(symbol: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.callout)
                        .foregroundStyle(theme.secondaryLabel)
                    if model.isLoading {
                        SkeletonBar(width: 80, height: 24)
                    } else {
                        Text(value)
                            .font(.visionCardTitle)
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Table

    private struct Header: Identifiable {
        let key: String
        let trailing: Bool
        var id: String { key }
    }

    private var headers: [Header] {
        [
            Header(key: "dbMaintenance.col.table", trailing: false),
            Header(key: "dbMaintenance.col.liveRows", trailing: true),
            Header(key: "dbMaintenance.col.deadRows", trailing: true),
            Header(key: "dbMaintenance.col.lastVacuum", trailing: false),
            Header(key: "dbMaintenance.col.lastAnalyze", trailing: false),
            Header(key: "dbMaintenance.col.size", trailing: true),
        ]
    }

    @ViewBuilder
    private var table: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                ForEach(headers) { header in
                    Text(strings.t(header.key))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(theme.secondaryLabel)
                        .padding(.vertical, 8)
                        .gridColumnAlignment(header.trailing ? .trailing : .leading)
                        .accessibilityAddTraits(.isHeader)
                }
                // `sr-only`: read by VoiceOver, not drawn.
                Text(strings.t("dbMaintenance.col.actions"))
                    .font(.caption)
                    .foregroundStyle(Color.clear)
                    .gridColumnAlignment(.trailing)
                    .accessibilityAddTraits(.isHeader)
            }
            if model.isLoading {
                ForEach(0..<5, id: \.self) { _ in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(0..<7, id: \.self) { _ in SkeletonBar(width: 72, height: 14).padding(.vertical, 10) }
                    }
                }
            } else {
                ForEach(model.rows(settings: shell.settings)) { row in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    tableRow(row)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(model.isLoading ? .updatesFrequently : [])
        if model.showsEmptyState {
            VisionEmptyState(symbol: "cylinder", title: strings.t("dbMaintenance.noTables")) {
                Button(strings.t("dbMaintenance.refresh")) {
                    Task { await model.refresh() }
                }
                .buttonStyle(.visionOutline)
            }
            .padding(.vertical, 24)
        }
    }

    private func tableRow(_ row: DatabaseTableRow) -> GridRow<some View> {
        GridRow {
            Button {
                shell.navigate(to: row.editorRoute)
            } label: {
                Text(row.table)
                    .font(.footnote.monospaced())
                    .underline()
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.primary)
            .accessibilityAddTraits(.isLink)
            .padding(.vertical, 8)
            Text(row.liveRows).monospacedDigit()
            Text(row.deadRows)
                .monospacedDigit()
                .foregroundStyle(row.hasManyDeadRows ? theme.warning : theme.foreground)
            Text(row.lastVacuum)
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
                .fixedSize()
            Text(row.lastAnalyze)
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
                .fixedSize()
            Text(row.size)
                .fontWeight(.medium)
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()
            rowMenu(row)
        }
    }

    /// `dbMaintenance.rowMenu`: Browse rows and Run vacuum (disabled while any vacuum runs).
    private func rowMenu(_ row: DatabaseTableRow) -> some View {
        Menu {
            Button {
                shell.navigate(to: row.editorRoute)
            } label: {
                Label(strings.t("dbMaintenance.openTable"), systemImage: "tablecells")
            }
            Button {
                Task { await model.vacuum(table: row.table, strings: strings) }
            } label: {
                Label(strings.t("dbMaintenance.vacuumTable"), systemImage: "bolt")
            }
            .disabled(model.isVacuuming)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.button)
        .buttonStyle(.vision(.ghost, size: .iconSm))
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("dbMaintenance.rowMenu", ["table": row.table]))
        .visionTooltip(strings.t("dbMaintenance.rowMenu", ["table": row.table]))
    }
}
