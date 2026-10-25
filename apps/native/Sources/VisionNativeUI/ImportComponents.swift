import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore

/// `CsvDropzone`: click, Return or Space opens the Open panel (CSV files), a dragged file
/// highlights it and a dropped one is taken; with a file it shows the name, the size in KB
/// and Remove.
struct CSVDropzone: View {
    let file: ImportFile?
    var label: String?
    var compact = false
    let strings: any Localizing
    let choose: @MainActor @Sendable (ImportFile) -> Void
    /// A dropped or picked file could not be read.
    let unreadable: @MainActor @Sendable () -> Void
    let remove: () -> Void
    @State private var isTargeted = false
    @State private var isPickerPresented = false
    @Environment(\.visionTheme) var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label).font(.body.weight(.medium))
            }
            zone
        }
    }

    private var zone: some View {
        VStack(spacing: 10) {
            if let file {
                Image(systemName: "doc")
                    .font(.system(size: compact ? 28 : 34))
                    .foregroundStyle(theme.primary)
                    .accessibilityHidden(true)
                VStack(spacing: 2) {
                    Text(verbatim: file.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(verbatim: "\(file.sizeInKilobytes) \(strings.t("common.kb"))")
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                Button(role: .destructive, action: remove) {
                    Label(strings.t("importPage.remove"), systemImage: "trash")
                }
                .buttonStyle(.vision(.ghost, size: .sm))
            } else {
                Image(systemName: "icloud.and.arrow.up")
                    .font(.system(size: compact ? 28 : 34))
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
                if compact {
                    Text(strings.t("importPage.dropzoneSmall"))
                        .font(.callout)
                        .foregroundStyle(theme.secondaryLabel)
                } else {
                    VStack(spacing: 2) {
                        Text(strings.t("importPage.dropzone")).font(.body.weight(.medium))
                        Text(strings.t("importPage.dropzoneOr"))
                            .font(.callout)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    .multilineTextAlignment(.center)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(compact ? 28 : 36)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(isTargeted ? theme.primary.opacity(0.05) : Color.clear))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(
                    isTargeted ? theme.primary : theme.border,
                    style: StrokeStyle(lineWidth: 2, dash: [6, 4])))
        .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
        .onTapGesture { isPickerPresented = true }
        .focusable()
        .onKeyPress(keys: [.return, .space]) { _ in
            isPickerPresented = true
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("importPage.dropzoneAria"))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { isPickerPresented = true }
        // `data-dropzone`: this drop is the dropzone's, not the screen's.
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first, url.isFileURL else { return false }
            Task {
                guard let file = await ImportFile.read(url) else {
                    unreadable()
                    return
                }
                choose(file)
            }
            return true
        } isTargeted: { targeted in
            isTargeted = targeted
        }
        .fileImporter(isPresented: $isPickerPresented, allowedContentTypes: [.commaSeparatedText]) { result in
            guard case .success(let url) = result else { return }
            Task {
                guard let file = await ImportFile.read(url) else {
                    unreadable()
                    return
                }
                choose(file)
            }
        }
    }
}

/// A labelled field of the custom setup.
struct ImportField<Content: View>: View {
    let label: String
    var required = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: required ? "\(label) *" : label)
                .font(.callout.weight(.medium))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The Custom CSV setup: a saved parser's read-only summary with Edit and Delete, or the
/// editor (name, separator, date format, number format, encoding, skip rows and the column
/// mapping) with Save and, for a saved parser, Cancel.
struct ImportCustomSetup: View {
    let model: ImportsModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    private static let columns = [GridItem(.flexible(), spacing: 16, alignment: .top), GridItem(.flexible(), spacing: 16, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Text(strings.t("importPage.customConfig"))
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if model.showsSavedSummary {
                    Button(strings.t("importPage.customParser.edit")) { model.startEditing() }
                        .buttonStyle(.vision(.outline, size: .sm))
                    Button(strings.t("importPage.customParser.delete"), role: .destructive) {
                        model.requestParserDelete()
                    }
                    .buttonStyle(.vision(.ghost, size: .sm))
                    .disabled(model.isDeletingParser)
                }
            }
            if model.showsSavedSummary {
                summary
            }
            if model.showsEditor {
                editor
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.foreground.opacity(0.04)))
    }

    /// The Saved setup `dl`.
    private var summary: some View {
        LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 6) {
            ForEach(Array(model.summaryRows(strings).enumerated()), id: \.offset) { _, row in
                HStack(spacing: 12) {
                    Text(row.label).foregroundStyle(theme.secondaryLabel)
                    Spacer(minLength: 8)
                    Text(verbatim: row.value)
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(.footnote)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("importPage.savedParserSummary"))
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 16) {
            ImportField(label: strings.t("importPage.customParser.name")) {
                TextField(
                    strings.t("importPage.customBankName"),
                    text: Binding(get: { model.parserName }, set: { model.parserName = $0 })
                )
                .textFieldStyle(.vision)
            }
            LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 16) {
                ImportField(label: strings.t("importPage.separator")) {
                    VisionSelect(
                        selection: binding(\.separator),
                        options: CSVSeparator.candidates.map { separator in
                            VisionSelectOption(
                                value: separator, title: CSVSeparator.labelKey(separator).map { strings.t($0) } ?? separator)
                        },
                        accessibilityLabel: strings.t("importPage.separator"), expands: true)
                }
                ImportField(label: strings.t("importPage.dateFormat")) {
                    VisionSelect(
                        selection: binding(\.dateFormat),
                        options: CSVFormatOptions.dateFormats.map { option in
                            VisionSelectOption(value: option.value, title: option.label)
                        },
                        accessibilityLabel: strings.t("importPage.dateFormat"), expands: true)
                }
                ImportField(label: strings.t("importPage.numberFormat.label")) {
                    VisionSelect(
                        selection: binding(\.numberFormat),
                        options: OpenAPI.CsvNumberFormat.allCases.map { format in
                            VisionSelectOption(value: format, title: strings.t(CSVFormatOptions.numberFormatKey(format)))
                        },
                        accessibilityLabel: strings.t("importPage.numberFormat.label"), expands: true)
                    Text(strings.t("importPage.numberFormat.hint"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ImportField(label: strings.t("importPage.encoding")) {
                    VisionSelect(
                        selection: Binding(
                            get: { CSVFormatOptions.selectedEncoding(model.config.encoding) },
                            set: { model.config.encoding = $0 }),
                        options: CSVFormatOptions.encodings.map { option in
                            VisionSelectOption(value: option.value, title: option.label)
                        },
                        accessibilityLabel: strings.t("importPage.encoding"), expands: true)
                }
                ImportField(label: strings.t("importPage.skipRows")) {
                    HStack(spacing: 6) {
                        TextField(
                            "0",
                            text: Binding(
                                get: { String(model.config.skipRows) },
                                set: { model.config.skipRows = CSVParserConfig.skipRows(from: $0) })
                        )
                        .textFieldStyle(.vision)
                        .frame(maxWidth: 120)
                        Stepper(
                            strings.t("importPage.skipRows"),
                            value: Binding(get: { model.config.skipRows }, set: { model.config.skipRows = max(0, $0) }),
                            in: 0...10_000
                        )
                        .labelsHidden()
                    }
                }
            }
            columnMapper
            Text(strings.t("importPage.requiredNote"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
            HStack(spacing: 8) {
                Button(strings.t(model.isSaved ? "importPage.customParser.saveChanges" : "importPage.customParser.save")) {
                    Task { await model.saveParser(strings: strings) }
                }
                .buttonStyle(.vision(.default, size: .sm))
                .disabled(!model.canSaveParser)
                if model.isSaved {
                    Button(strings.t("common.cancel")) { model.cancelEditing() }
                        .buttonStyle(.vision(.ghost, size: .sm))
                }
            }
        }
    }

    /// `CsvColumnMapper`: a select of the detected headers (with Not mapped), or a text field
    /// while the file has none.
    private var columnMapper: some View {
        let headers = model.mapperHeaders
        return LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 16) {
            ForEach(CSVColumnField.allCases) { field in
                ImportField(label: strings.t(field.labelKey), required: field.isRequired) {
                    if headers.isEmpty {
                        TextField(strings.t(field.placeholderKey), text: binding(field.keyPath))
                            .textFieldStyle(.vision)
                    } else {
                        VisionSelect(
                            selection: binding(field.keyPath),
                            options: mappingOptions(headers, current: model.config[keyPath: field.keyPath]),
                            accessibilityLabel: strings.t(field.labelKey), expands: true)
                    }
                }
            }
        }
    }

    /// Not mapped, then the headers.
    private func mappingOptions(_ headers: [String], current: String) -> [VisionSelectOption<String>] {
        var list = [VisionSelectOption(value: "", title: strings.t("importPage.noMapping"))]
        for header in options(headers, current: current) {
            list.append(VisionSelectOption(value: header, title: header))
        }
        return list
    }

    /// The headers, plus a mapped column the file does not have (so the select can show it).
    private func options(_ headers: [String], current: String) -> [String] {
        var seen = Set<String>()
        var list = headers.filter { !$0.isEmpty && seen.insert($0).inserted }
        if !current.isEmpty, !seen.contains(current) { list.append(current) }
        return list
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<CSVParserConfig, Value>) -> Binding<Value> {
        Binding(get: { model.config[keyPath: keyPath] }, set: { model.config[keyPath: keyPath] = $0 })
    }
}

/// `FileHeadersPanel`: the detected columns of the chosen file, as chips (mapped ones
/// highlighted), with up to five sample rows behind a disclosure.
struct ImportHeadersPanel: View {
    let model: ImportsModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        switch model.headersPanel {
        case .hidden:
            EmptyView()
        case .unreadable:
            Label(strings.t("csvHeaders.unreadable"), systemImage: "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .strokeBorder(theme.border.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        case .loaded(let preview, let detected):
            loaded(preview, detected: detected)
        }
    }

    private func loaded(_ preview: CSVPreview, detected: String?) -> some View {
        let highlighted = model.highlightedHeaders
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Label(strings.t("csvHeaders.title"), systemImage: "tablecells")
                    .font(.footnote.weight(.medium))
                Text(strings.t("csvHeaders.columns", ["n": String(preview.headers.count)]))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                if let detected {
                    Text(strings.t("csvHeaders.delimiterDetected", ["sep": CSVSeparator.symbol(detected)]))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                Spacer(minLength: 0)
            }
            FlowLayout(spacing: 6) {
                ForEach(Array(preview.headers.enumerated()), id: \.offset) { _, header in
                    VisionBadge(text: header.isEmpty ? "—" : header, tone: highlighted.contains(header) ? .primary : .secondary)
                }
            }
            if !preview.rows.isEmpty {
                DisclosureGroup(
                    isExpanded: Binding(get: { model.isSampleRowsExpanded }, set: { model.setSampleRowsExpanded($0) })
                ) {
                    sampleTable(preview, highlighted: highlighted)
                        .padding(.top, 6)
                } label: {
                    Text(strings.t("csvHeaders.sampleRows"))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.card.opacity(0.7)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }

    private func sampleTable(_ preview: CSVPreview, highlighted: Set<String>) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(preview.headers.enumerated()), id: \.offset) { _, header in
                        Text(verbatim: header)
                            .fontWeight(.medium)
                            .foregroundStyle(highlighted.contains(header) ? theme.primary : theme.secondaryLabel)
                    }
                }
                Divider()
                ForEach(Array(preview.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                            let isMapped = index < preview.headers.count && highlighted.contains(preview.headers[index])
                            Text(verbatim: cell.isEmpty ? "—" : cell)
                                .lineLimit(1)
                                .frame(maxWidth: 140, alignment: .leading)
                                .foregroundStyle(isMapped ? theme.foreground : theme.secondaryLabel)
                        }
                    }
                }
            }
            .font(.footnote)
            .padding(10)
        }
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }
}

/// Lays chips out in rows, wrapping at the available width.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    /// Pins the last subview to the trailing edge of its row (the web's `ml-auto`).
    var lastTrailing = false

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            if lastTrailing, index == subviews.count - 1 { x = max(x, bounds.maxX - size.width) }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// `ImportHistoryCard`: Refresh, the batches of the page with their status, counts, Resume
/// review and Roll back, and Previous / Next.
struct ImportHistoryCard: View {
    let model: ImportsModel
    let strings: any Localizing
    let resumeReview: (Int) -> Void
    @Environment(\.visionTheme) var theme

    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(strings.t("importHistory.title"))
                            .font(.visionCardTitle)
                            .accessibilityAddTraits(.isHeader)
                        Text(strings.t("importHistory.desc"))
                            .font(.body)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    Spacer()
                    Button {
                        Task { await model.refreshHistory(strings: strings) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .symbolEffect(.rotate, isActive: model.isHistoryFetching)
                    }
                    .buttonStyle(.vision(.ghost, size: .iconSm))
                    .disabled(model.isHistoryFetching)
                    .accessibilityLabel(strings.t("common.refresh"))
                    .visionTooltip(strings.t("common.refresh"))
                }
                content
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isHistoryLoading {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, minHeight: 80)
        } else if model.historyBatches.isEmpty {
            VisionEmptyState(
                symbol: "clock.arrow.circlepath", title: strings.t("importHistory.empty"), compact: true
            ) { EmptyView() }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(model.historyBatches.enumerated()), id: \.element.id) { index, batch in
                    if index > 0 { Divider() }
                    row(batch)
                }
            }
            if model.historyTotalPages > 1 {
                HStack {
                    Text(
                        strings.t(
                            "importHistory.page",
                            ["page": String(model.historyCurrentPage), "total": String(model.historyTotalPages)])
                    )
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    Spacer()
                    Button(strings.t("common.previous")) {
                        Task { await model.showPreviousPage(strings: strings) }
                    }
                    .disabled(!model.canShowPreviousPage)
                    Button(strings.t("common.next")) {
                        Task { await model.showNextPage(strings: strings) }
                    }
                    .disabled(!model.canShowNextPage)
                }
                .buttonStyle(.visionOutline)
                .controlSize(.small)
                .padding(.top, 8)
            }
        }
    }

    private func row(_ batch: OpenAPI.ImportBatch) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(verbatim: batch.title(strings))
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    VisionBadge(text: strings.t(ImportBatchStatus.labelKey(batch.status)), tone: tone(batch.status), small: true)
                }
                FlowLayout(spacing: 12) {
                    Text(verbatim: batch.adapterName)
                    Text(verbatim: batch.startedText())
                    Text(strings.t("importPage.imported", ["n": String(batch.rowsImported)]))
                        .foregroundStyle(theme.success)
                    if batch.rowsDuplicate > 0 {
                        Text(strings.t("importPage.duplicates", ["n": String(batch.rowsDuplicate)]))
                            .foregroundStyle(theme.warning)
                    }
                    if batch.rowsError > 0 {
                        Text(strings.t("importPage.errors", ["n": String(batch.rowsError)]))
                            .foregroundStyle(theme.destructive)
                    }
                    if batch.transactionsRemaining > 0 {
                        Text(strings.t("importHistory.remaining", ["n": String(batch.transactionsRemaining)]))
                    }
                }
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                if let summary = batch.errorSummary, !summary.isEmpty {
                    Text(verbatim: summary)
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                        .lineLimit(1)
                        .frame(maxWidth: 320, alignment: .leading)
                }
            }
            Spacer(minLength: 8)
            if batch.canResumeReview, let id = batch.numericId {
                Button {
                    resumeReview(id)
                } label: {
                    Label(strings.t("importHistory.resumeReview"), systemImage: "doc.text.magnifyingglass")
                }
                .buttonStyle(.vision(.ghost, size: .sm))
            }
            if batch.canRollBack {
                let rolling = model.rollingBack.contains(batch.id)
                Button(role: .destructive) {
                    model.requestRollback(batch)
                } label: {
                    if rolling {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.mini)
                            Text(strings.t("importHistory.rollback"))
                        }
                    } else {
                        Label(strings.t("importHistory.rollback"), systemImage: "arrow.uturn.backward")
                    }
                }
                .buttonStyle(.vision(.ghost, size: .sm))
                .disabled(rolling)
            }
        }
        .padding(.vertical, 10)
    }

    private func tone(_ status: OpenAPI.ImportBatch.Status) -> BadgeTone {
        switch ImportBatchStatus.tone(status) {
        case .primary: return .primary
        case .secondary: return .secondary
        case .destructive: return .destructive
        case .outline: return .outline
        }
    }
}
