import Foundation
import Observation

@MainActor
@Observable
public final class PortfolioScreens {
    public private(set) var dataRevision = 0
    public let model: PortfolioModel
    public let editing: PortfolioEditingModel
    public let rebalance: RebalanceModel
    public let netWorth: NetWorthModel
    public let tax: PortfolioTaxModel

    public init(client: APIClient, now: @escaping @Sendable () -> Date = { Date() }) {
        model = PortfolioModel(service: client, now: now)
        editing = PortfolioEditingModel(service: client)
        rebalance = RebalanceModel(service: client, now: now)
        netWorth = NetWorthModel(service: client, now: now)
        tax = PortfolioTaxModel(service: client, now: now)
        model.pricesDidChange = { [weak self] in
            guard let self else { return }
            netWorth.invalidate()
            rebalance.invalidate()
            tax.invalidate()
            dataRevision &+= 1
        }
        netWorth.pricesDidChange = { [weak self] in
            guard let self else { return }
            model.invalidate()
            rebalance.invalidate()
            tax.invalidate()
            dataRevision &+= 1
        }
        editing.bindChanged { [weak self] in
            guard let self else { return }
            let selectedWasActive = model.selectedInvestment?.isActive == true
            model.invalidate()
            netWorth.invalidate()
            rebalance.invalidate()
            tax.invalidate()
            await model.load(currency: model.currency, force: true)
            dataRevision &+= 1
            if let id = model.selectedInvestmentId {
                if selectedWasActive && model.error == nil && model.investment(id: id)?.isActive != true {
                    model.closeDetail()
                    return
                }
                _ = await model.loadHistory(investmentId: id)
                editing.bindTransactions(model.transactions)
            }
        }
    }
    public func invalidate() {
        model.invalidate()
        editing.invalidateBrokerHistory()
        netWorth.invalidate()
        rebalance.invalidate()
        tax.invalidate()
    }

    /// Import and settings writes can complete after navigation, including lost acknowledgements.
    public func dataDidChange() {
        invalidate()
        dataRevision &+= 1
    }
}
