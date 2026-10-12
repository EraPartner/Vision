import SwiftUI
import VisionNativeCore

/// `/admin/db/:table` (apps/frontend/src/pages/admin/TableDataEditorPage.tsx, ADR-101) in
/// SwiftUI: a fixed-width grid in a horizontal scroll view (a 3rem action column and 11rem
/// per data column), with sortable titles, per-column filters, inline cell editing, the
/// pending bar, the pagination footer and the Review pending changes sheet.
public struct TableDataEditorView: View {
    private let model: TableDataEditorModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    /// The cell whose inline editor has focus; losing it commits the edit (blur).
    @FocusState private var focusedEditor: TableDataEditorModel.Cell?
    @State private var hoveredSortColumn: String?

    /// 3rem and 11rem at the web's 16 pt rem.
    static let actionColumnWidth: CGFloat = 48
    static let dataColumnWidth: CGFloat = 176

    public init(model: TableDataEditorModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        let pending = model.hasPending
        AdminPage {
            backLink
            AdminPageHeader(title: model.table, subtitle: strings.t("dbEditor.subtitle")) {
                HStack(spacing: 8) {
                    moreActions
                    Button {
                        model.addRow()
                    } label: {
                        Label(strings.t("dbEditor.addRow"), systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isReadOnly)
                }
            }
            warning
            toolbar(pending: pending)
            if pending {
                Text(strings.t("dbEditor.lockedWhilePending"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
            if let error = model.errorState(strings: strings) {
                AdminErrorBanner(state: error, strings: strings) {
                    shell.navigate(to: AdminErrorState.tokenRoute)
                }
            }
            AdminCard(padding: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    ScrollView(.horizontal) {
                        grid(pending: pending)
                    }
                    Divider()
                    footer(pending: pending)
                }
            }
        }
        .task { await model.appear() }
        .onAppear { shell.setLeaveGuard(model.leaveGuard) }
        .onDisappear {
            model.commitEditing()
            shell.removeLeaveGuard(id: model.leaveGuard.id)
        }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: model.notice, strings: strings) { model.clearNotice($0) }
        }
        .sheet(isPresented: reviewPresented) {
            ReviewChangesSheet(model: model, strings: strings)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
        }
    }

    private var reviewPresented: Binding<Bool> {
        Binding(get: { model.isReviewPresented }, set: { model.isReviewPresented = $0 })
    }

    // MARK: Header

    /// `dbEditor.back`: to `/admin/db`, through the unsaved-changes guard.
    private var backLink: some View {
        Button {
            shell.navigate(to: TableEditorRoute.maintenancePath)
        } label: {
            Label(strings.t("dbEditor.back"), systemImage: "chevron.left")
                .font(.callout)
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.secondaryLabel)
        .accessibilityAddTraits(.isLink)
    }

    /// `admin.moreActions`: Refresh, disabled while fetching.
    private var moreActions: some View {
        Menu {
            Button {
                Task { await model.refresh() }
            } label: {
                Label(strings.t("dbEditor.refresh"), systemImage: "arrow.clockwise")
            }
            .disabled(model.isFetching)
        } label: {
            Image(systemName: model.isFetching ? "arrow.clockwise" : "ellipsis")
                .symbolEffect(.rotate, options: .repeat(.continuous), isActive: model.isFetching)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("admin.moreActions"))
        .help(strings.t("admin.moreActions"))
    }

    /// The warning alert, with the dashboard note on the materialized-view base tables.
    private var warning: some View {
        let text =
            model.refreshesMaterializedViews
            ? "\(strings.t("dbEditor.warning")) \(strings.t("dbEditor.warningMatview"))" : strings.t("dbEditor.warning")
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(theme.warning)
                .accessibilityHidden(true)
            Text(text)
                .font(.callout)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.warning.opacity(0.08)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(theme.warning.opacity(0.4), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    /// Apply filters, the background-fetch cue and the pending bar.
    private func toolbar(pending: Bool) -> some View {
        HStack(spacing: 8) {
            Button {
                Task { await model.applyFilters() }
            } label: {
                Label(strings.t("dbEditor.applyFilters"), systemImage: "magnifyingglass")
            }
            .buttonStyle(.bordered)
            .disabled(pending)
            if model.isShowingPreviousPage {
                ProgressView()
                    .controlSize(.small)
            }
            Spacer(minLength: 8)
            if pending {
                let count = strings.tc("dbEditor.pendingCount", model.pendingCount)
                Text(count)
                    .font(.callout.weight(.medium))
                    // `role="status"`: the count is announced as it changes.
                    .task(id: count) { AccessibilityNotification.Announcement(count).post() }
                Button {
                    model.discardAll()
                } label: {
                    Label(strings.t("dbEditor.discard"), systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(.borderless)
                Button {
                    Task { await model.preview(strings: strings) }
                } label: {
                    Label(strings.t("dbEditor.preview"), systemImage: "eye")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isPreviewing)
            }
        }
    }

    // MARK: Grid

    private var gridWidth: CGFloat {
        Self.actionColumnWidth + CGFloat(model.columns.count) * Self.dataColumnWidth
    }

    private func grid(pending: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sortRow(pending: pending)
            filterRow(pending: pending)
            Divider()
            if model.isLoading {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(0..<8, id: \.self) { _ in
                        SkeletonBar(width: nil, height: 14)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                        Divider()
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(model.table))
                .accessibilityAddTraits(.updatesFrequently)
            }
            ForEach(Array(model.newRows.enumerated()), id: \.element.id) { index, row in
                newRowView(row, index: index)
                Divider()
            }
            if !model.isLoading {
                ForEach(model.rows) { row in
                    loadedRowView(row)
                    Divider()
                }
            }
            if model.showsEmptyState {
                VStack(spacing: 8) {
                    Image(systemName: "tablecells")
                        .font(.title2)
                        .foregroundStyle(theme.tertiaryLabel)
                        .accessibilityHidden(true)
                    Text(strings.t("dbEditor.empty"))
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            }
        }
        .frame(minWidth: gridWidth, alignment: .leading)
        .onChange(of: focusedEditor) { previous, _ in
            // Focus left an open editor without Enter or Escape: stage the typed text.
            if let previous, model.editingCell == previous { model.commitEditing() }
        }
    }

    /// Row 1 of the header: the sortable column titles, a key on primary-key columns.
    private func sortRow(pending: Bool) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.actionColumnWidth, height: 1)
            ForEach(model.columns, id: \.name) { column in
                let active = model.sort?.column == column.name ? model.sort : nil
                Button {
                    Task { await model.toggleSort(column.name) }
                } label: {
                    HStack(spacing: 6) {
                        if model.primaryKey.contains(column.name) {
                            Image(systemName: "key.fill")
                                .foregroundStyle(theme.warning)
                                .accessibilityLabel(Text(verbatim: "PK"))
                        }
                        Text(column.name)
                            .font(.footnote.monospaced())
                            .multilineTextAlignment(.leading)
                        if let active {
                            Image(systemName: active.direction == .asc ? "chevron.up" : "chevron.down")
                                .foregroundStyle(theme.primary)
                                .accessibilityHidden(true)
                        } else {
                            Image(systemName: "chevron.up.chevron.down")
                                .foregroundStyle(theme.tertiaryLabel)
                                .opacity(hoveredSortColumn == column.name && !pending ? 1 : 0)
                                .accessibilityHidden(true)
                        }
                    }
                    .imageScale(.small)
                    .foregroundStyle(theme.secondaryLabel)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(pending)
                .onHover { inside in
                    if inside {
                        hoveredSortColumn = column.name
                    } else if hoveredSortColumn == column.name {
                        hoveredSortColumn = nil
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .frame(width: Self.dataColumnWidth, alignment: .leading)
            }
        }
        .background(theme.foreground.opacity(0.015))
    }

    /// Row 2 of the header: a filter input per column; Enter applies the filters.
    private func filterRow(pending: Bool) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.actionColumnWidth, height: 1)
            ForEach(model.columns, id: \.name) { column in
                HStack(spacing: 4) {
                    Image(systemName: "magnifyingglass")
                        .imageScale(.small)
                        .foregroundStyle(theme.tertiaryLabel)
                        .accessibilityHidden(true)
                    TextField(strings.t("dbEditor.filterPlaceholder"), text: filterBinding(column.name))
                        .textFieldStyle(.plain)
                        .font(.footnote.monospaced())
                        .onSubmit { Task { await model.applyFilters() } }
                        .accessibilityLabel("\(strings.t("dbEditor.filterPlaceholder")) \(column.name)")
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                        .strokeBorder(theme.border, lineWidth: 1))
                .disabled(pending)
                .opacity(pending ? 0.5 : 1)
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
                .frame(width: Self.dataColumnWidth, alignment: .leading)
            }
        }
        .background(theme.foreground.opacity(0.015))
    }

    private func filterBinding(_ column: String) -> Binding<String> {
        Binding(get: { model.draftFilters[column] ?? "" }, set: { model.draftFilters[column] = $0 })
    }

    // MARK: Rows

    private func newRowView(_ row: TableDataEditorModel.NewRow, index: Int) -> some View {
        HStack(spacing: 0) {
            Menu {
                Button(role: .destructive) {
                    model.discardNewRow(row.id)
                } label: {
                    Label(strings.t("dbEditor.discardNewRow"), systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .modifier(RowMenuStyle(label: strings.t("dbEditor.rowMenu")))
            ForEach(model.columns, id: \.name) { column in
                cellView(
                    TableDataEditorModel.Cell(row: row.id, column: column.name, isNew: true), column: column,
                    label: strings.t(
                        "dbEditor.cellLabel",
                        ["column": column.name, "row": "\(strings.t("dbEditor.addRow")) \(index + 1)"]),
                    deleted: false)
            }
        }
        .background(theme.success.opacity(0.05))
    }

    private func loadedRowView(_ row: TableDataEditorModel.Row) -> some View {
        let deleted = model.isDeleted(row)
        let rowLabel = model.rowLabel(row)
        return HStack(spacing: 0) {
            Menu {
                Button {
                    model.revertRow(row)
                } label: {
                    Label(strings.t("dbEditor.revertRow"), systemImage: "arrow.uturn.backward")
                }
                .disabled(!model.canRevertRow(row))
                Divider()
                if deleted {
                    Button {
                        model.toggleDelete(row)
                    } label: {
                        Label(strings.t("dbEditor.undoDelete"), systemImage: "arrow.uturn.backward")
                    }
                    .disabled(model.isReadOnly)
                } else {
                    Button(role: .destructive) {
                        model.toggleDelete(row)
                    } label: {
                        Label(strings.t("dbEditor.deleteRow"), systemImage: "trash")
                    }
                    .disabled(model.isReadOnly)
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .modifier(RowMenuStyle(label: strings.t("dbEditor.rowMenu")))
            ForEach(model.columns, id: \.name) { column in
                cellView(
                    TableDataEditorModel.Cell(row: row.id, column: column.name), column: column,
                    label: strings.t("dbEditor.cellLabel", ["column": column.name, "row": rowLabel]),
                    deleted: deleted)
            }
        }
        .background(deleted ? theme.destructive.opacity(0.05) : Color.clear)
        .opacity(deleted ? 0.6 : 1)
    }

    // MARK: Cells

    @ViewBuilder
    private func cellView(
        _ cell: TableDataEditorModel.Cell, column: OpenAPI.DbEditorColumn, label: String, deleted: Bool
    ) -> some View {
        let dirty = model.isDirty(cell)
        let editable = model.canEdit(cell)
        Group {
            if TableCellValue.isBoolean(column) {
                booleanCell(cell, label: label, dirty: dirty, editable: editable)
            } else if model.editingCell == cell {
                inlineEditor(cell, label: label)
            } else {
                textCell(cell, label: label, dirty: dirty, editable: editable, deleted: deleted)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(width: Self.dataColumnWidth, alignment: .leading)
        .frame(minHeight: 36)
        .background(dirty ? theme.warning.opacity(0.1) : Color.clear)
        .overlay(
            Rectangle()
                .strokeBorder(dirty ? theme.warning.opacity(0.4) : Color.clear, lineWidth: 1))
    }

    private func booleanCell(_ cell: TableDataEditorModel.Cell, label: String, dirty: Bool, editable: Bool)
        -> some View
    {
        HStack(spacing: 6) {
            Toggle(
                isOn: Binding(
                    get: { model.value(cell) == .bool(true) },
                    set: { model.setValue(.bool($0), for: cell) })
            ) {
                Text(label)
            }
            .toggleStyle(.checkbox)
            .labelsHidden()
            .disabled(!editable)
            .accessibilityLabel(label)
            .onKeyPress(.escape) {
                guard dirty else { return .ignored }
                model.revertCell(cell)
                return .handled
            }
            if dirty && editable { revertButton(cell) }
            Spacer(minLength: 0)
        }
    }

    private var editingText: Binding<String> {
        Binding(get: { model.editingText }, set: { model.editingText = $0 })
    }

    /// Enter commits, Escape reverts the cell, and leaving the field commits (blur).
    private func inlineEditor(_ cell: TableDataEditorModel.Cell, label: String) -> some View {
        TextField(label, text: editingText)
            .textFieldStyle(.roundedBorder)
            .font(.footnote.monospaced())
            .labelsHidden()
            .accessibilityLabel(label)
            .focused($focusedEditor, equals: cell)
            .onSubmit { model.commitEditing() }
            .onKeyPress(.escape) {
                model.cancelEditing()
                return .handled
            }
            .onAppear { focusedEditor = cell }
    }

    private func textCell(
        _ cell: TableDataEditorModel.Cell, label: String, dirty: Bool, editable: Bool, deleted: Bool
    ) -> some View {
        let shown = TableCellValue.display(model.value(cell))
        return HStack(spacing: 4) {
            Text(shown.text)
                .font(.footnote.monospaced())
                .italic(shown.isNull)
                .strikethrough(deleted)
                .foregroundStyle(shown.isNull ? theme.tertiaryLabel : theme.foreground)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            if dirty && editable { revertButton(cell) }
            if model.canSetNull(cell) {
                Button {
                    model.setValue(.null, for: cell)
                } label: {
                    Image(systemName: "nosign")
                        .imageScale(.small)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.tertiaryLabel)
                .help(strings.t("dbEditor.setNull"))
                .accessibilityLabel(strings.t("dbEditor.setNull"))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.beginEditing(cell) }
        .focusable(editable)
        .onKeyPress(keys: [.return, .space]) { _ in
            guard editable else { return .ignored }
            model.beginEditing(cell)
            return .handled
        }
        .help(strings.t(model.tooltipKey(cell)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(shown.text)
        .accessibilityAddTraits(editable ? .isButton : [])
        .accessibilityAction {
            model.beginEditing(cell)
        }
    }

    private func revertButton(_ cell: TableDataEditorModel.Cell) -> some View {
        Button {
            model.revertCell(cell)
        } label: {
            Image(systemName: "arrow.uturn.backward")
                .imageScale(.small)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(theme.warning)
        .help(strings.t("dbEditor.revertCell"))
        .accessibilityLabel(strings.t("dbEditor.revertCell"))
    }

    // MARK: Footer

    private func footer(pending: Bool) -> some View {
        HStack(spacing: 8) {
            Text(strings.tc("dbEditor.rowsOnPage", model.rowCount))
            Spacer(minLength: 8)
            Button {
                Task { await model.previousPage() }
            } label: {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.bordered)
            .disabled(!model.canGoToPreviousPage)
            .accessibilityLabel(strings.t("dbEditor.prevPage"))
            .help(strings.t("dbEditor.prevPage"))
            Text(strings.t("dbEditor.pageNumber", ["page": String(model.pageNumber)]))
                .monospacedDigit()
            Button {
                Task { await model.nextPage() }
            } label: {
                Image(systemName: "chevron.right")
            }
            .buttonStyle(.bordered)
            .disabled(!model.canGoToNextPage)
            .accessibilityLabel(strings.t("dbEditor.nextPage"))
            .help(strings.t("dbEditor.nextPage"))
        }
        .font(.footnote)
        .foregroundStyle(theme.secondaryLabel)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

/// The row menu of the action column (`RowMenu`, `dbEditor.rowMenu`).
private struct RowMenuStyle: ViewModifier {
    let label: String

    func body(content: Content) -> some View {
        content
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel(label)
            .help(label)
            .frame(width: TableDataEditorView.actionColumnWidth)
    }
}

/// The Review pending changes dialog: the summary, the delete warning, the dry run's SQL
/// statements, Cancel and Commit to database.
struct ReviewChangesSheet: View {
    let model: TableDataEditorModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let counts = model.operationCounts
        VStack(alignment: .leading, spacing: 14) {
            Text(strings.t("dbEditor.previewTitle"))
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text(strings.t("dbEditor.previewDescription"))
                .foregroundStyle(theme.secondaryLabel)
            Text(
                strings.t(
                    "dbEditor.commitSummary",
                    [
                        "inserts": String(counts.inserts), "updates": String(counts.updates),
                        "deletes": String(counts.deletes),
                    ])
            )
            .fontWeight(.medium)
            if model.hasDeletes {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                    Text(strings.t("dbEditor.deleteWarning"))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(theme.destructive)
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .fill(theme.destructive.opacity(0.06)))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .strokeBorder(theme.destructive.opacity(0.4), lineWidth: 1))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(model.previewStatements.enumerated()), id: \.offset) { _, statement in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(statement.op)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(theme.secondaryLabel)
                            Text(verbatim: "\(statement.preview);")
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if model.previewStatements.isEmpty {
                        Text(strings.t("dbEditor.previewEmpty"))
                            .foregroundStyle(theme.secondaryLabel)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
            .frame(maxHeight: 360)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                    .fill(theme.foreground.opacity(0.04)))
            HStack(spacing: 8) {
                Spacer()
                Button(strings.t("dbEditor.cancel")) {
                    model.isReviewPresented = false
                }
                .keyboardShortcut(.cancelAction)
                Button(model.isCommitting ? strings.t("dbEditor.committing") : strings.t("dbEditor.commit")) {
                    Task { await model.commit(strings: strings) }
                }
                .buttonStyle(.borderedProminent)
                .tint(model.hasDeletes ? theme.destructive : theme.primary)
                .disabled(!model.canCommit)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 720)
        .foregroundStyle(theme.foreground)
    }
}
