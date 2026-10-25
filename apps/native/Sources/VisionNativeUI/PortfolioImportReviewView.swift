import SwiftUI
import VisionNativeCore

/// Server-staged rows stay immutable: this review maps complete instrument groups.
public struct PortfolioImportReviewView: View {
    let model: PortfolioImportReviewModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    public init(model: PortfolioImportReviewModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(
                    title: strings.t("portfolioImport.review.title"),
                    subtitle: strings.t("portfolioImport.review.subtitle"), symbol: "square.and.arrow.down"
                ) {
                    if model.preview != nil {
                        Text(strings.t("portfolioImport.review.matched", ["n": String(model.matchedCount)]))
                            .font(.caption).padding(6).background(theme.foreground.opacity(0.06), in: Capsule())
                        if model.unresolvedCount > 0 {
                            Text(strings.t("portfolioImport.review.unresolved", ["n": String(model.unresolvedCount)]))
                                .font(.caption).foregroundStyle(theme.warning)
                        }
                    }
                }
                if model.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let error = model.error {
                    AdminCard {
                        Text(strings.t("importPage.failed")).font(.headline)
                        Text(verbatim: error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        Button(strings.t("common.retry")) {
                            Task {
                                if let id = model.batchId {
                                    await model.load(batchId: id, force: true)
                                } else {
                                    await load()
                                }
                            }
                        }
                    }
                } else if model.preview != nil {
                    AdminCard {
                        Text(routing).foregroundStyle(routingUnavailable ? theme.warning : theme.secondaryLabel)
                    }
                    ForEach(model.groups) { group in
                        PortfolioImportPreviewGroupView(group: group, model: model, shell: shell)
                    }
                    footer
                }
                if let notice = model.notice, notice != "portfolioImport.toast.importSuccess" {
                    Text(strings.t(notice)).foregroundStyle(theme.success).accessibilityAddTraits(.updatesFrequently)
                }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.task(id: shell.route.path) { await load() }
    }
    private func load() async {
        guard case .native(.portfolioImportReview(let batchId)) = shell.detail else { return }
        if let id = shell.nativeNavigationLocation.match?.supportedBatchId {
            await model.load(batchId: PortfolioImportBatchNumericID(id))
        } else {
            await model.load(rawBatchId: batchId.rawValue)
        }
    }
    private var routingUnavailable: Bool {
        model.requiresAccountRepair && !model.brokerAccounts.contains { $0.id == model.selectedRepairBrokerId }
    }
    private var routing: String {
        if routingUnavailable { return strings.t("portfolioImport.review.routingUnavailable") }
        let one = model.tradeCount == 1 ? "One" : ""
        if let broker = model.routingAccountName {
            return strings.t(
                "portfolioImport.review.routingBroker\(one)", ["count": String(model.tradeCount), "broker": broker])
        }
        return strings.t("portfolioImport.review.routingUnassigned\(one)", ["count": String(model.tradeCount)])
    }
    private var footer: some View {
        AdminCard {
            HStack(alignment: .bottom) {
                if model.requiresAccountRepair {
                    Picker(
                        strings.t("portfolioImport.review.cashAccount"),
                        selection: Binding(
                            get: { model.selectedRepairBrokerId }, set: { model.selectedRepairBrokerId = $0 })
                    ) {
                        Text(strings.t("addPortTxn.broker.unassigned")).tag(Optional<AccountID>.none)
                        ForEach(model.brokerAccounts, id: \.id) { account in
                            Text(verbatim: account.displayName ?? account.name).tag(Optional(account.id))
                        }
                    }.disabled(model.isBusy)
                }
                Spacer()
                Button(strings.t("common.cancel")) { shell.navigate(to: "/portfolio") }
                Button {
                    Task {
                        if await model.commit() {
                            shell.replace(with: "/portfolio")
                        }
                    }
                } label: {
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Text(strings.t("portfolioImport.review.commit"))
                }.buttonStyle(.visionPrimary).disabled(!model.canCommit)
            }
        }
    }
}

private struct PortfolioImportPreviewGroupView: View {
    let group: PortfolioImportPreviewGroup
    let model: PortfolioImportReviewModel
    let shell: NativeShellModel
    @State private var choosing = false
    @State private var search = ""
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var unresolved: Bool { !group.isCash && group.investmentId == nil }
    private var title: String {
        if group.isCash { return strings.t("portfolioImport.review.cashMovements") }
        if let name = group.investmentName {
            return group.investmentSymbol.map { "\(name) (\($0))" } ?? name
        }
        return group.rawSymbol ?? group.rawName ?? strings.t("portfolioImport.review.unknownInstrument")
    }
    private var holdings: [PortfolioInvestment] {
        model.investments.filter {
            $0.isActive
                && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)
                    || ($0.symbol?.localizedCaseInsensitiveContains(search) ?? false))
        }
    }
    var body: some View {
        AdminCard {
            HStack {
                if unresolved { Image(systemName: "exclamationmark.triangle").foregroundStyle(theme.warning) }
                Text(verbatim: title).font(.headline)
                Spacer()
                Text(verbatim: String(group.rowCount)).font(.caption).monospacedDigit()
            }
            if !group.resolvableRowIds.isEmpty {
                HStack {
                    Text(strings.t("portfolioImport.review.holding")).font(.subheadline.weight(.medium))
                    Button {
                        search = ""
                        choosing = true
                    } label: {
                        Text(group.investmentName ?? strings.t("combobox.investment.placeholder"))
                        Image(systemName: "chevron.up.chevron.down")
                    }.buttonStyle(.visionOutline).popover(isPresented: $choosing) {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField(strings.t("combobox.investment.search"), text: $search).textFieldStyle(.vision)
                            if holdings.isEmpty {
                                Text(strings.t("combobox.investment.empty")).foregroundStyle(theme.secondaryLabel)
                            }
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 8) {
                                    ForEach(holdings) { investment in
                                        Button {
                                            choosing = false
                                            Task { await model.override(group: group, investmentId: investment.id) }
                                        } label: {
                                            HStack {
                                                Text(
                                                    verbatim: investment.symbol.map { "\(investment.name) (\($0))" }
                                                        ?? investment.name)
                                                Spacer()
                                                if investment.id == group.investmentId {
                                                    Image(systemName: "checkmark")
                                                }
                                            }.frame(maxWidth: .infinity, alignment: .leading)
                                        }.buttonStyle(.plain)
                                    }
                                }
                            }.frame(maxHeight: 300)
                        }.padding(12).frame(width: 360)
                    }
                    if unresolved {
                        Button(strings.t("portfolioImport.review.createNew"), systemImage: "plus.circle") {
                            Task { await model.createNew(group: group) }
                        }.buttonStyle(.visionOutline)
                    }
                    if model.busyGroup == group.id { ProgressView().controlSize(.small) }
                }.disabled(model.isBusy || model.isLoading)
            }
            // Lazy rows retain the web's unformatted server decimal strings and window scrolling.
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(group.rows) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(verbatim: row.txDate ?? "").foregroundStyle(theme.secondaryLabel)
                        Text(verbatim: row.type?.rawValue ?? row.typeRaw ?? "").padding(3)
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(theme.border))
                        if let units = row.units { Text(verbatim: "\(units) @ \(row.pricePerUnit ?? "—")") }
                        if let amount = row.amount {
                            Text(verbatim: "\(amount) \(row.currency ?? "")").foregroundStyle(theme.secondaryLabel)
                        }
                        if row.status == "error", let error = row.errorMessage {
                            Text(verbatim: error).foregroundStyle(theme.destructive)
                        }
                    }.font(.caption).monospacedDigit().padding(.vertical, 8).textSelection(.enabled)
                    Divider()
                }
            }
        }
    }
}
