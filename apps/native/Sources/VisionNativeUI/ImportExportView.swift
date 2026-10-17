import SwiftUI
import VisionNativeCore

/// `/import` (apps/frontend/src/pages/ImportPage.tsx) in SwiftUI: the page header, the commit
/// receipt, the bank import card with its dropzone, bank source, custom CSV setup, detected
/// columns and progress, and Import history. Delete parser? and Roll back import? ask in
/// alerts; the screen's unsaved-work guard covers a chosen file and an unsaved parser edit.
/// The sidebar holds the export card and Setup and reference; below the wide breakpoint
/// (the web's `xl`) it moves under the main column.
public struct ImportExportView: View {
    /// The width from which the sidebar sits beside the main column.
    nonisolated static let sidebarBreakpoint: CGFloat = 960
    nonisolated static let sidebarWidth: CGFloat = 360

    private let model: ImportsModel
    private let shell: NativeShellModel
    @State private var isWide = true
    @Environment(\.visionTheme) private var theme

    public init(model: ImportsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        AdminPage {
            VisionPageHeader(title: strings.t("importPage.title"), subtitle: strings.t("importPage.subtitle"), symbol: symbol)
            if let receipt = model.commitReceipt {
                ImportCommitReceiptCard(receipt: receipt, strings: strings) {
                    shell.navigate(to: receipt.transactionsRoute(filterLabel: strings.t("importPage.importedFilterLabel")))
                } dismiss: {
                    model.dismissCommitReceipt()
                }
            }
            if isWide {
                HStack(alignment: .top, spacing: 24) {
                    mainColumn
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    sidebar
                        .frame(width: Self.sidebarWidth, alignment: .topLeading)
                }
            } else {
                VStack(alignment: .leading, spacing: 24) {
                    mainColumn
                    sidebar
                }
            }
        }
        .onGeometryChange(for: Bool.self) { proxy in
            proxy.size.width >= Self.sidebarBreakpoint
        } action: { wide in
            isWide = wide
        }
        .task { await model.appear(strings: strings) }
        .onAppear { shell.setLeaveGuard(model.leaveGuard) }
        .onDisappear {
            shell.removeLeaveGuard(id: ImportRoutes.path)
            model.disappear()
        }
        .onChange(of: model.navigationRequest) { _, url in
            guard let url else { return }
            shell.navigate(to: url)
            model.didHandleNavigation()
        }
        .overlay(alignment: .bottom) {
            ImportToastStack(center: model.toasts, strings: strings) { route in shell.navigate(to: route) }
        }
        // `useConfirmDialog`, destructive. The buttons decide; the binding only reads.
        .alert(
            strings.t("importPage.customParser.deleteTitle"),
            isPresented: Binding(get: { model.pendingParserDelete != nil }, set: { _ in })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { model.cancelParserDelete() }
            Button(strings.t("importPage.customParser.delete"), role: .destructive) {
                Task { await model.confirmParserDelete(strings: strings) }
            }
        } message: {
            Text(strings.t("importPage.customParser.deleteConfirm", ["name": model.pendingParserDelete?.name ?? ""]))
        }
        .alert(
            strings.t("importHistory.rollbackTitle"),
            isPresented: Binding(get: { model.pendingRollback != nil }, set: { _ in })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { model.cancelRollback() }
            Button(strings.t("importHistory.rollbackConfirm"), role: .destructive) {
                Task { await model.confirmRollback(strings: strings) }
            }
        } message: {
            if let batch = model.pendingRollback {
                Text(
                    strings.t(
                        "importHistory.rollbackDesc",
                        ["n": String(batch.transactionsRemaining), "file": batch.title(strings)]))
            }
        }
    }

    private var mainColumn: some View {
        VStack(alignment: .leading, spacing: 24) {
            ImportBankCard(model: model, strings: strings)
            ImportHistoryCard(model: model, strings: strings) { batchId in
                shell.navigate(to: ImportRoutes.reviewPath(batchId))
            }
        }
    }

    /// The `aside`: the export card, then Setup and reference.
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 24) {
            ImportExportCard(model: model.export, settings: shell.settings, strings: strings)
            ImportSetupReferenceCard(model: model, strings: strings)
        }
    }

    private var symbol: String {
        NavigationRegistry.matchItem(path: ImportRoutes.path)?.symbol ?? "square.and.arrow.down"
    }
}

/// The commit receipt (`role="status"`): Import complete, the imported count, duplicates and
/// errors, Show imported transactions and the dismiss button.
struct ImportCommitReceiptCard: View {
    let receipt: ImportCommitReceipt
    let strings: any Localizing
    let showImported: () -> Void
    let dismiss: () -> Void
    @Environment(\.visionTheme) var theme

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(theme.success)
                .symbolEffect(.bounce, value: receipt)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("importPage.commitReceiptTitle"))
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    RollingNumber(value: String(receipt.imported))
                        .fontWeight(.semibold)
                        .foregroundStyle(theme.foreground)
                    Text(strings.tc("importPage.commitReceiptImported", receipt.imported))
                        .foregroundStyle(theme.secondaryLabel)
                }
                Text(
                    verbatim: strings.tc("importPage.commitReceiptDuplicates", receipt.duplicates) + " · "
                        + strings.tc("importPage.commitReceiptErrors", receipt.errors)
                )
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                if receipt.imported > 0 {
                    Button(action: showImported) {
                        Label(strings.tc("importPage.showImported", receipt.imported), systemImage: "arrow.right")
                            .labelStyle(TrailingIconLabelStyle())
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .padding(.top, 8)
                }
            }
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(strings.t("importPage.dismissCommitReceipt"))
            .help(strings.t("importPage.dismissCommitReceipt"))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.success.opacity(0.06)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).strokeBorder(theme.success.opacity(0.3), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

/// A label with its icon after the title, like the web's trailing arrow.
struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon
        }
    }
}

/// `TransactionImportCard`: the file, then the bank, then (for a custom or saved setup) the
/// column mapping; the footer names what is still missing and holds Import and Cancel.
struct ImportBankCard: View {
    let model: ImportsModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        AdminCard(padding: 20) {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("importPage.csvImport"))
                        .font(.title3.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text(strings.t("importPage.csvImportDesc"))
                        .font(.callout)
                        .foregroundStyle(theme.secondaryLabel)
                }
                CSVDropzone(
                    file: model.file, label: strings.t("importPage.csvFile"), strings: strings,
                    choose: { model.chooseFile($0) }, unreadable: { model.fileUnreadable() },
                    remove: { model.removeFile() })
                bankSource
                if model.isCustomLike {
                    ImportCustomSetup(model: model, strings: strings)
                }
                ImportHeadersPanel(model: model, strings: strings)
                progressPanel
                footer
            }
        }
    }

    // MARK: Bank source

    /// Sentinel tags of the disabled Loading and No banks items.
    private static let loadingTag = ImportSource.adapter("\u{0}loading")
    private static let noneTag = ImportSource.adapter("\u{0}none")

    private var bankSource: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t("importPage.bankSource"))
                .font(.body.weight(.medium))
            Picker(
                strings.t("importPage.bankSource"),
                selection: Binding(get: { model.source }, set: { model.selectSource($0) })
            ) {
                Text(strings.t("importPage.bankSourcePlaceholder"))
                    .foregroundStyle(theme.secondaryLabel)
                    .tag(ImportSource?.none)
                    .disabled(true)
                if model.isLoadingAdapters {
                    Text(strings.t("importPage.loading")).tag(Optional(Self.loadingTag)).disabled(true)
                } else if let adapters = model.adapters, !adapters.isEmpty {
                    ForEach(adapters, id: \.key) { adapter in
                        Label(adapter.name, systemImage: "building.columns")
                            .tag(Optional(ImportSource.adapter(adapter.key)))
                    }
                } else {
                    Text(strings.t("importPage.noParsers")).tag(Optional(Self.noneTag)).disabled(true)
                }
                if let parsers = model.savedParsers, !parsers.isEmpty {
                    Divider()
                    ForEach(parsers, id: \.id) { parser in
                        Label(parser.name, systemImage: "bookmark")
                            .tag(Optional(ImportSource.saved(parser.id)))
                    }
                }
                Divider()
                Label(strings.t("importPage.customOther"), systemImage: "pencil.line")
                    .tag(Optional(ImportSource.custom))
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: 420, alignment: .leading)
            Text(strings.t("importPage.bankHint"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
        }
    }

    // MARK: Progress

    @ViewBuilder
    private var progressPanel: some View {
        if let progress = model.progress {
            if model.isImporting {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(progress.labelKey.map { strings.t($0) } ?? "")
                            .font(.body.weight(.medium))
                            .foregroundStyle(theme.secondaryLabel)
                        Spacer()
                        Text(verbatim: "\(progress.percent)%")
                            .font(.body.weight(.medium).monospacedDigit())
                    }
                    ProgressView(value: progress.fraction)
                        .progressViewStyle(.linear)
                        .tint(theme.primary)
                    if progress.showsCounts {
                        HStack(spacing: 16) {
                            Text(
                                strings.t(
                                    "importPage.rows", ["current": String(progress.current), "total": String(progress.total)])
                            )
                            .monospacedDigit()
                            .foregroundStyle(theme.secondaryLabel)
                            Text(strings.t("importPage.imported", ["n": String(progress.imported)]))
                                .foregroundStyle(theme.success)
                            Text(strings.t("importPage.duplicates", ["n": String(progress.duplicates)]))
                                .foregroundStyle(theme.warning)
                            if progress.errors > 0 {
                                Text(strings.t("importPage.errors", ["n": String(progress.errors)]))
                                    .foregroundStyle(theme.destructive)
                            }
                        }
                        .font(.footnote)
                    }
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.foreground.opacity(0.04)))
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            } else if progress.phase == "complete" {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .symbolEffect(.bounce, value: progress)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(strings.t("importPage.complete")).font(.body.weight(.medium))
                        Text(
                            strings.t(
                                "importPage.progressSummary",
                                [
                                    "imported": String(progress.imported), "duplicates": String(progress.duplicates),
                                    "errors": String(progress.errors),
                                ])
                        )
                        .font(.footnote)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(theme.success)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.success.opacity(0.1)))
                .accessibilityElement(children: .combine)
            } else if progress.phase == "error" {
                HStack(spacing: 12) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .accessibilityHidden(true)
                    Text(strings.t("importPage.failed")).font(.body.weight(.medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(theme.destructive)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.destructive.opacity(0.05)))
                .accessibilityElement(children: .combine)
                // `role="alert"`.
                .task(id: progress) { AccessibilityNotification.Announcement(strings.t("importPage.failed")).post() }
            }
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 12) {
            Divider()
            HStack(spacing: 12) {
                Text(strings.t(model.hintKey ?? "importPage.hint.ready"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if model.isImporting {
                    Button(strings.t("importPage.cancelBtn")) { model.cancelImport() }
                        .buttonStyle(.borderless)
                }
                Button {
                    Task { await model.startImport(strings: strings) }
                } label: {
                    if model.isImporting {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(strings.t("importPage.importingBtn"))
                        }
                    } else {
                        Label(strings.t("importPage.importBtn"), systemImage: "square.and.arrow.up")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canImport)
            }
        }
    }
}
