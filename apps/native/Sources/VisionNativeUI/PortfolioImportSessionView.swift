import SwiftUI
import VisionNativeCore

struct PortfolioImportSessionView: View {
    let model: PortfolioImportSessionModel
    let shell: NativeShellModel
    var isLocked = false
    var onReviewHistory: () -> Void = {}
    var onRecover: () async -> Void = {}
    @State private var fileErrorKey: String?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var locked: Bool { isLocked || model.locked }
    var body: some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 20) {
                Text(strings.t("portfolioImport.session.title")).font(.headline)
                Text(strings.t("portfolioImport.session.description")).foregroundStyle(theme.secondaryLabel)
                PortfolioImportFileDropzone(
                    multiple: true, strings: strings, isDisabled: locked,
                    maximumFiles: max(0, 100 - model.statements.count),
                    onFiles: { files in
                        fileErrorKey = nil
                        await model.addFiles(files)
                    }, onUnreadable: { fileErrorKey = "portfolioImport.invalidFile" },
                    onTooMany: { fileErrorKey = "portfolioImport.session.tooMany" })
                if let key = fileErrorKey { Text(strings.t(key)).foregroundStyle(theme.destructive) }
                existingHistory
                ForEach(model.statements) { statement in
                    PortfolioImportStatementView(statement: statement, model: model, shell: shell, isLocked: isLocked)
                }
                scopeSettings
                HStack(spacing: 12) {
                    Button(strings.t("portfolioImport.session.stage")) { Task { await model.stage() } }
                        .buttonStyle(.visionPrimary).disabled(
                            !model.canStage || model.operation != "idle" || isLocked)
                    if model.operation == "staging" {
                        Button(strings.t("portfolioImport.session.stop")) { model.stop() }
                    }
                    Button(strings.t("portfolioImport.session.preview")) { Task { await model.preview() } }
                        .disabled(!model.canPreview || isLocked)
                    if !model.statements.isEmpty {
                        Button(strings.t("portfolioImport.session.clear")) { model.clear() }.disabled(locked)
                    }
                }
                if model.stopped {
                    Text(strings.t("portfolioImport.session.stopped")).foregroundStyle(theme.secondaryLabel)
                }
                if model.operation == "preview" {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(strings.t("portfolioImport.session.previewing"))
                    }
                }
                if let error = model.error {
                    Text(strings.t(error)).foregroundStyle(theme.destructive).textSelection(.enabled)
                }
                if model.outcomeUncertain {
                    Text(strings.t("portfolioImport.session.responseUnverified")).foregroundStyle(theme.warning)
                    HStack {
                        Button(strings.t("portfolioImport.session.history.title"), action: onReviewHistory)
                        Button(strings.t("common.retry")) { Task { await onRecover() } }.disabled(
                            locked || model.isBusy)
                    }
                }
                PortfolioImportReconciliationView(model: model, shell: shell)
            }
        }
    }
    private var existingHistory: some View {
        DisclosureGroup(strings.t("portfolioImport.session.existing.title")) {
            VStack(alignment: .leading, spacing: 12) {
                Text(strings.t("portfolioImport.session.existing.hint")).font(.callout).foregroundStyle(
                    theme.secondaryLabel)
                Button(strings.t("portfolioImport.session.existing.load")) {
                    Task { await model.loadExistingBatches() }
                }
                .disabled(locked || model.existingLoading)
                if model.existingLoading { ProgressView().controlSize(.small) }
                if let page = model.existingBatches {
                    Picker(
                        strings.t("portfolioImport.session.existing.choose"),
                        selection: Binding(get: { model.existingBatchId }, set: { model.existingBatchId = $0 })
                    ) {
                        Text(strings.t("portfolioImport.session.existing.unselected")).tag("")
                        ForEach(model.eligibleExistingBatches) { batch in
                            Text(
                                strings.t(
                                    "portfolioImport.session.existing.option",
                                    [
                                        "name": batch.sourceFilename ?? batch.adapterName, "id": String(batch.id),
                                        "account": model.brokerAccounts.first { $0.id == batch.accountId }.map {
                                            $0.displayName ?? $0.name
                                        } ?? "",
                                        "status": strings.t("portfolioImport.session.existing.status." + batch.status),
                                    ])
                            ).tag(String(batch.id))
                        }
                    }.disabled(locked || model.existingLoading)
                    HStack {
                        Button(strings.t("portfolioImport.session.existing.add")) { model.addExistingBatch() }
                            .disabled(locked || model.existingBatchId.isEmpty || model.statements.count >= 100)
                        if page.offset > 0 {
                            Button(strings.t("portfolioImport.session.existing.newer")) {
                                Task { await model.loadExistingBatches(offset: max(0, page.offset - 50)) }
                            }.disabled(locked || model.existingLoading)
                        }
                        if page.offset + page.items.count < page.total {
                            Button(strings.t("portfolioImport.session.existing.older")) {
                                Task { await model.loadExistingBatches(offset: page.offset + 50) }
                            }.disabled(locked || model.existingLoading)
                        }
                    }
                }
            }.padding(.top, 12)
        }
    }
    private var scopeSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker(
                strings.t("portfolioImport.session.scope"),
                selection: Binding(get: { model.reconciliationMode }, set: { model.setMode($0) })
            ) {
                Text(strings.t("portfolioImport.session.fullHistory")).tag(PortfolioImportReconciliationMode.full)
                Text(strings.t("portfolioImport.session.recordCash")).tag(
                    PortfolioImportReconciliationMode.recordCashOnly
                ).disabled(!model.attachmentEligible)
                Text(strings.t("portfolioImport.session.recordInKindIncome")).tag(
                    PortfolioImportReconciliationMode.recordInKindIncomeOnly
                ).disabled(!model.attachmentEligible)
                Text(strings.t("portfolioImport.session.correctExistingRecords")).tag(
                    PortfolioImportReconciliationMode.correctExistingOnly
                ).disabled(!model.correctionEligible)
                Text(strings.t("portfolioImport.session.attachSourceRecords")).tag(
                    PortfolioImportReconciliationMode.adoptExistingOnly
                ).disabled(!model.attachmentEligible)
            }.disabled(locked)
            Text(strings.t(scopeHint)).font(.caption).foregroundStyle(theme.secondaryLabel)
            if model.reconciliationMode == .recordCashOnly {
                Toggle(
                    strings.t("portfolioImport.session.cashFundingConfirmation"),
                    isOn: Binding(get: { model.cashFundingConfirmed }, set: { model.setCashFundingConfirmed($0) })
                )
                .disabled(locked)
                Text(strings.t("portfolioImport.session.cashFundingHint")).font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            }
            if model.existingOnly && !model.scopeValid {
                Text(strings.t(scopeUnavailable)).font(.callout).foregroundStyle(theme.destructive)
            }
            Picker(
                strings.t("portfolioImport.session.policy"),
                selection: Binding(get: { model.policy }, set: { model.setPolicy($0) })
            ) {
                Text(strings.t("portfolioImport.session.auto")).tag("auto")
                Text(strings.t("portfolioImport.session.preserve")).tag("preserve_existing")
                Text(strings.t("portfolioImport.session.source")).tag("prefer_source")
            }.disabled(locked || model.existingOnly)
            Text(strings.t(policyHint)).font(.caption).foregroundStyle(theme.secondaryLabel)
        }
    }
    private var scopeHint: String {
        switch model.reconciliationMode {
        case .full: "portfolioImport.session.fullHistoryHint"
        case .adoptExistingOnly: "portfolioImport.session.attachmentHint"
        case .correctExistingOnly: "portfolioImport.session.correctionHint"
        case .recordInKindIncomeOnly: "portfolioImport.session.incomeHint"
        case .recordCashOnly: "portfolioImport.session.cashHint"
        }
    }
    private var scopeUnavailable: String {
        switch model.reconciliationMode {
        case .recordCashOnly: "portfolioImport.session.cashUnavailable"
        case .recordInKindIncomeOnly: "portfolioImport.session.incomeUnavailable"
        case .correctExistingOnly: "portfolioImport.session.correctionUnavailable"
        default: "portfolioImport.session.attachmentUnavailable"
        }
    }
    private var policyHint: String {
        switch model.reconciliationMode {
        case .recordCashOnly: "portfolioImport.session.cashPolicyHint"
        case .recordInKindIncomeOnly: "portfolioImport.session.incomePolicyHint"
        case .correctExistingOnly: "portfolioImport.session.correctionPolicyHint"
        default: "portfolioImport.session.policyHint." + model.policy
        }
    }
}
