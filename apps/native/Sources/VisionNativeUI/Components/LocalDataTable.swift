import SwiftUI
import VisionNativeCore

/// One column of `LocalDataTable`: its raw key, its header (empty for an untitled column)
/// and its cell.
struct LocalDataColumn<Row>: Identifiable {
    let key: String
    let title: String
    /// The starting width (`defaultWidth`), or the minimum of the flexible column.
    let width: CGFloat
    let minWidth: CGFloat
    /// The column that takes the remaining width (`minWidth` only on the web).
    var flexible = false
    var alignment: Alignment = .leading
    let cell: (Row) -> AnyView

    var id: String { key }
    /// Titled columns sort, filter and resize.
    var isTitled: Bool { !title.isEmpty }
}

/// The table chrome of `VirtualDataTable` for rows that are all loaded: the title and
/// subtitle, the search field with its clear button, Clear all with the filter count, the
/// filter chips, header buttons that cycle the sort, the column filter popovers, resize
/// handles (drag, or the arrow keys by 10 pt), the rows and the count footer.
struct LocalDataTable<Row: Identifiable, Empty: View>: View {
    let title: String
    let subtitle: String
    let columns: [LocalDataColumn<Row>]
    let rows: [Row]
    /// The rows before search and filters, for the footer.
    let totalCount: Int
    @Binding var query: LocalTableQuery
    let filterValues: (String) -> [String]
    let strings: any Localizing
    let empty: () -> Empty
    @State private var openFilter: String?
    @State private var widths: [String: CGFloat] = [:]
    @State private var hoveredHeader: String?
    @Environment(\.visionTheme) private var theme

    init(
        title: String, subtitle: String, columns: [LocalDataColumn<Row>], rows: [Row], totalCount: Int,
        query: Binding<LocalTableQuery>, filterValues: @escaping (String) -> [String], strings: any Localizing,
        @ViewBuilder empty: @escaping () -> Empty
    ) {
        self.title = title
        self.subtitle = subtitle
        self.columns = columns
        self.rows = rows
        self.totalCount = totalCount
        _query = query
        self.filterValues = filterValues
        self.strings = strings
        self.empty = empty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading
            toolbar
            if !query.filters.isEmpty { chips }
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    headerRow
                    Divider()
                    if rows.isEmpty {
                        empty()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(rows) { row in
                                rowView(row)
                                Divider()
                            }
                        }
                    }
                }
                .containerRelativeFrame(.horizontal, alignment: .leading) { length, _ in
                    max(length, minimumTableWidth)
                }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            Divider()
            footer
        }
    }

    // MARK: Heading and toolbar

    private var heading: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle)
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
                TextField(strings.t("table.searchAllColumns"), text: $query.search)
                    .textFieldStyle(.plain)
                    .accessibilityLabel(strings.t("table.searchAllColumns"))
                if !query.search.isEmpty {
                    Button {
                        query.search = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.tertiaryLabel)
                    .help(strings.t("aria.clearSearch"))
                    .accessibilityLabel(strings.t("aria.clearSearch"))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: 360)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                    .fill(theme.foreground.opacity(0.04)))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                    .strokeBorder(theme.border, lineWidth: 1))
            if query.showsClearAll {
                Button {
                    query.clearAll()
                } label: {
                    HStack(spacing: 6) {
                        Text(strings.t("table.clearAll"))
                        if query.activeFilterCount > 0 {
                            VisionBadge(text: String(query.activeFilterCount), tone: .primary, small: true)
                        }
                    }
                }
                .buttonStyle(.borderless)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    private var chips: some View {
        HStack(spacing: 6) {
            ForEach(query.filters) { filter in
                let name = columns.first(where: { $0.key == filter.key })?.title ?? filter.key
                HStack(spacing: 4) {
                    Image(systemName: "line.3.horizontal.decrease")
                        .imageScale(.small)
                        .accessibilityHidden(true)
                    Text(verbatim: "\(name): \(filter.value)")
                        .lineLimit(1)
                    Button {
                        query.setFilter(filter.key, to: "")
                    } label: {
                        Image(systemName: "xmark")
                            .imageScale(.small)
                    }
                    .buttonStyle(.borderless)
                    .help(strings.t("aria.clearNamedFilter", ["name": name]))
                    .accessibilityLabel(strings.t("aria.clearNamedFilter", ["name": name]))
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(theme.primary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                        .fill(theme.primary.opacity(0.1)))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    // MARK: Header

    private var minimumTableWidth: CGFloat {
        columns.reduce(32) { $0 + width(of: $1) }
    }

    private func width(of column: LocalDataColumn<Row>) -> CGFloat {
        widths[column.key] ?? column.width
    }

    private func widthBinding(_ column: LocalDataColumn<Row>) -> Binding<CGFloat> {
        Binding(
            get: { width(of: column) },
            set: { widths[column.key] = min(LocalDataTableMetrics.maximumWidth, max(column.minWidth, $0)) })
    }

    private var headerRow: some View {
        HStack(spacing: 0) {
            ForEach(columns) { column in
                headerCell(column)
                    .frame(width: column.flexible ? nil : width(of: column), alignment: column.alignment)
                    .frame(
                        minWidth: column.flexible ? width(of: column) : nil,
                        maxWidth: column.flexible ? .infinity : nil, alignment: column.alignment)
            }
        }
        .padding(.horizontal, 16)
        .background(theme.foreground.opacity(0.03))
    }

    @ViewBuilder
    private func headerCell(_ column: LocalDataColumn<Row>) -> some View {
        if column.isTitled {
            HStack(spacing: 4) {
                sortButton(column)
                filterButton(column)
                Spacer(minLength: 0)
                ColumnResizeHandle(label: column.title, width: widthBinding(column))
            }
            .onHover { inside in
                if inside {
                    hoveredHeader = column.key
                } else if hoveredHeader == column.key {
                    hoveredHeader = nil
                }
            }
        } else {
            Color.clear.frame(height: 1)
        }
    }

    private func sortButton(_ column: LocalDataColumn<Row>) -> some View {
        let active = query.sort?.key == column.key ? query.sort : nil
        return Button {
            query.toggleSort(column.key)
        } label: {
            HStack(spacing: 4) {
                Text(column.title)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Image(systemName: active.map { $0.ascending ? "arrow.up" : "arrow.down" } ?? "arrow.up.arrow.down")
                    .imageScale(.small)
                    .foregroundStyle(active == nil ? theme.tertiaryLabel : theme.primary)
                    .opacity(active == nil && hoveredHeader != column.key ? 0.5 : 1)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(theme.secondaryLabel)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(Text(verbatim: active.map { $0.ascending ? "ascending" : "descending" } ?? ""))
    }

    private func filterButton(_ column: LocalDataColumn<Row>) -> some View {
        let hasFilter = !query.filter(for: column.key).isEmpty
        let label = strings.t("aria.filterColumn", ["header": column.title])
        return Button {
            openFilter = column.key
        } label: {
            Image(systemName: hasFilter ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                .imageScale(.small)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(hasFilter ? theme.primary : theme.tertiaryLabel)
        .opacity(hasFilter || hoveredHeader == column.key || openFilter == column.key ? 1 : 0.35)
        .help(label)
        .accessibilityLabel(label)
        .popover(isPresented: filterPresented(column.key), arrowEdge: .bottom) {
            ColumnFilterPopover(
                header: column.title,
                value: Binding(
                    get: { query.filter(for: column.key) }, set: { query.setFilter(column.key, to: $0) }),
                uniqueValues: openFilter == column.key ? filterValues(column.key) : [], strings: strings,
                close: { openFilter = nil }
            )
            .environment(\.visionTheme, theme)
        }
    }

    private func filterPresented(_ key: String) -> Binding<Bool> {
        Binding(
            get: { openFilter == key },
            set: { presented in
                if presented {
                    openFilter = key
                } else if openFilter == key {
                    openFilter = nil
                }
            })
    }

    // MARK: Rows

    private func rowView(_ row: Row) -> some View {
        HStack(spacing: 0) {
            ForEach(columns) { column in
                column.cell(row)
                    .padding(.trailing, 8)
                    .padding(.vertical, 8)
                    .frame(width: column.flexible ? nil : width(of: column), alignment: column.alignment)
                    .frame(
                        minWidth: column.flexible ? width(of: column) : nil,
                        maxWidth: column.flexible ? .infinity : nil, alignment: column.alignment)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
    }

    // MARK: Footer

    /// `table.shownOfFiltered` while search or filters hide rows, else `table.loadedOf`.
    private var footer: some View {
        let text =
            rows.count != totalCount
            ? strings.t("table.shownOfFiltered", ["shown": String(rows.count), "total": String(totalCount)])
            : strings.t("table.loadedOf", ["loaded": String(totalCount), "total": String(totalCount)])
        return Text(text)
            .font(.footnote)
            .foregroundStyle(theme.secondaryLabel)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
    }
}

/// The resize separator at a header's trailing edge: drag it, or focus it and press the left
/// or right arrow.
struct ColumnResizeHandle: View {
    let label: String
    @Binding var width: CGFloat
    @State private var dragStart: CGFloat?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme

    /// `width` clamps to the column's minimum and `MAX_COLUMN_WIDTH` itself.
    init(label: String, width: Binding<CGFloat>) {
        self.label = label
        _width = width
    }

    var body: some View {
        Rectangle()
            .fill(focused ? theme.primary : theme.border)
            .frame(width: focused ? 2 : 1, height: 16)
            .frame(width: 8, height: 28)
            .contentShape(Rectangle())
            .pointerStyle(.columnResize)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { drag in
                        let start = dragStart ?? width
                        if dragStart == nil { dragStart = start }
                        width = start + drag.translation.width
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onKeyPress(.leftArrow) {
                width -= LocalDataTableMetrics.resizeStep
                return .handled
            }
            .onKeyPress(.rightArrow) {
                width += LocalDataTableMetrics.resizeStep
                return .handled
            }
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue(Text(verbatim: String(Int(width))))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: width += LocalDataTableMetrics.resizeStep
                case .decrement: width -= LocalDataTableMetrics.resizeStep
                @unknown default: break
                }
            }
    }
}

enum LocalDataTableMetrics {
    /// The arrow-key step of a focused resize handle (`handleResizeKeyDown`).
    static let resizeStep: CGFloat = 10
    /// `MAX_COLUMN_WIDTH`.
    static let maximumWidth: CGFloat = 2000
}
