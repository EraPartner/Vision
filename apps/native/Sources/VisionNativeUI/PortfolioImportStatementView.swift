import SwiftUI
import VisionNativeCore

struct PortfolioImportStatementView: View {
    let statement: PortfolioImportStatement
    let model: PortfolioImportSessionModel
    let shell: NativeShellModel
    var isLocked = false
    @State private var changingBroker = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var readOnly: Bool { isLocked || model.locked || statement.file == nil || statement.status == "completed" }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: statement.name).font(.headline).lineLimit(2)
                    Text(strings.t(sourceKey)).font(.caption).foregroundStyle(theme.secondaryLabel)
                }
                Spacer()
                Button(strings.t("portfolioImport.session.remove"), systemImage: "xmark") {
                    model.remove(id: statement.id)
                }
                .buttonStyle(.borderless).disabled(isLocked || model.locked)
                .accessibilityLabel(strings.t("portfolioImport.session.removeFile", ["name": statement.name]))
            }
            if statement.detected != nil {
                broker
                if statement.accountId == nil {
                    Text(strings.t("portfolioImport.session.accountRequired")).foregroundStyle(theme.destructive)
                }
                // Funding rows carry no asset to scope.
                if statement.detected?.presetKey == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(strings.t("portfolioImport.session.assetScope")).font(.callout.weight(.medium))
                        TextField(
                            strings.t("portfolioImport.session.assetScope"),
                            text: Binding(
                                get: { statement.includedSymbols ?? "" },
                                set: { model.setSymbols(id: statement.id, symbols: $0) }),
                            prompt: Text(strings.t("portfolioImport.session.allAssets"))
                        )
                        .disabled(readOnly)
                        Text(strings.t("portfolioImport.session.assetScopeHelp")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }
                }
            }
            Picker(
                strings.t("portfolioImport.session.statementPolicy"),
                selection: Binding(
                    get: { statement.adoptPolicy },
                    set: { model.setStatementPolicy(id: statement.id, policy: $0) })
            ) {
                Text(strings.t("portfolioImport.session.useSessionPolicy")).tag(
                    Optional<PortfolioImportReconciliationPolicy>.none)
                Text(strings.t("portfolioImport.session.preserve")).tag(
                    Optional(PortfolioImportReconciliationPolicy.preserveExisting))
                Text(strings.t("portfolioImport.session.source")).tag(
                    Optional(PortfolioImportReconciliationPolicy.preferSource))
            }.disabled(isLocked || model.locked || statement.status == "completed")
                .accessibilityLabel(strings.t("portfolioImport.session.policyForFile", ["name": statement.name]))
            if let source = statement.detected?.source, ["nexo", "kinesis"].contains(source) {
                VStack(alignment: .leading, spacing: 6) {
                    Picker(
                        strings.t(
                            source == "nexo"
                                ? "portfolioImport.session.otherCustodyAccount"
                                : "portfolioImport.session.transferDestination"),
                        selection: Binding(
                            get: {
                                source != "nexo"
                                    || statement.transferOriginAccountId == statement.transferDestinationAccountId
                                    ? statement.transferDestinationAccountId : nil
                            }, set: { model.setTransferAccount(id: statement.id, accountId: $0) })
                    ) {
                        Text(
                            strings.t(
                                source == "nexo"
                                    ? "portfolioImport.session.custodyUnassigned"
                                    : "portfolioImport.session.transferUnassigned")
                        ).tag(Optional<Int>.none)
                        ForEach(model.brokerAccounts.filter { $0.id != statement.accountId }, id: \.id) { account in
                            Text(verbatim: account.displayName ?? account.name).tag(Optional(account.id))
                        }
                    }.disabled(readOnly)
                    Text(
                        strings.t(
                            source == "nexo"
                                ? "portfolioImport.session.otherCustodyHint" : "portfolioImport.session.transferHint")
                    )
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }
            if statement.status == "staging" {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(strings.t("portfolioImport.session.staging"))
                }
                if let progress = statement.progress {
                    PortfolioImportProgressView(progress: progress, strings: strings)
                }
            }
            if let batchId = statement.batchId {
                HStack(alignment: .firstTextBaseline) {
                    batchLink(batchId)
                    if let rows = statement.rows {
                        Text(
                            strings.t(
                                "portfolioImport.session.rows",
                                [
                                    "n": String(rows), "skipped": String(statement.skipped ?? 0),
                                    "errors": String(statement.sourceErrors ?? 0),
                                ])
                        ).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
            }
            ForEach(statement.previousBatchIds, id: \.self) { batchId in
                HStack {
                    Text(strings.t("portfolioImport.session.previousPending")).font(.caption).foregroundStyle(
                        theme.secondaryLabel)
                    batchLink(batchId)
                }
            }
            if let error = statement.error {
                Text(strings.t(error)).foregroundStyle(theme.destructive).textSelection(.enabled)
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.foreground.opacity(0.03), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
    }
    private var sourceKey: String {
        guard let detected = statement.detected else { return "portfolioImport.session.detecting" }
        if detected.presetKey == "ibkr_funding_history" { return "portfolioImport.ibkrFundingParser" }
        switch detected.source {
        case "ibkr": return "portfolioImport.ibkrParser"
        case "kinesis": return "portfolioImport.kinesisParser"
        case "nexo": return "portfolioImport.nexoParser"
        case "nexo_pro": return "portfolioImport.nexoProParser"
        case "saxo": return "portfolioImport.saxoParser"
        default: return "portfolioImport.session.detecting"
        }
    }
    @ViewBuilder private var broker: some View {
        if !changingBroker, let selected = model.brokerAccounts.first(where: { $0.id == statement.accountId }) {
            HStack {
                Text(strings.t("addPortTxn.broker")).font(.callout.weight(.medium))
                Text(verbatim: selected.name)
                Button(strings.t("addPortTxn.broker.change")) { changingBroker = true }.disabled(readOnly)
            }
        } else {
            Picker(
                strings.t("addPortTxn.broker"),
                selection: Binding(
                    get: { statement.accountId }, set: { model.setAccount(id: statement.id, accountId: $0) })
            ) {
                Text(strings.t("addPortTxn.broker.unassigned")).tag(Optional<Int>.none)
                ForEach(model.brokerAccounts, id: \.id) { account in
                    Text(verbatim: account.displayName ?? account.name).tag(Optional(account.id))
                }
            }.disabled(readOnly)
        }
    }
    private func batchLink(_ id: Int) -> some View {
        Button(strings.t("portfolioImport.session.batch", ["id": String(id)])) {
            shell.navigate(to: "/portfolio/import/\(id)/review")
        }.buttonStyle(.visionLink)
    }
}
