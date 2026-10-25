import Foundation
import Observation

public struct ResearchMarketBrokerContext: Sendable {
    public let accounts: [OpenAPI.Account]
    public let preferredBrokerId: AccountID?
    public init(accounts: [OpenAPI.Account], preferredBrokerId: AccountID?) {
        self.accounts = accounts
        self.preferredBrokerId = preferredBrokerId
    }
}
public struct ResearchMarketInvestmentDraft: Equatable, Sendable {
    public var name = "", currentPrice = "", currency = "EUR", notes = ""
    public init() {}
}
public struct ResearchMarketTradeDraft: Equatable, Sendable {
    /// Which account the trade books to: the one the history suggests, none, or a chosen one.
    public enum BrokerChoice: Equatable, Sendable {
        case preferred
        case unassigned
        case account(AccountID)
    }
    public var type = "buy", date = "", amount = "", units = "", price = "", fees = "", taxes = "", fx = "", note = ""
    public var dividendConvention = "unknown", recurrenceInterval = "monthly", recurrenceEndDate = ""
    public var broker: BrokerChoice = .preferred
    public var isRecurring = false
    public init() {}
}
/// This flow intentionally keeps the quote-native price while booking in the held summary's currency, matching web.
@MainActor @Observable public final class ResearchMarketActionModel {
    public var isPresented = false
    public var step = "choose"
    public var investment = ResearchMarketInvestmentDraft()
    public var trade = ResearchMarketTradeDraft() { didSet { if trade != oldValue { queueMath() } } }
    public private(set) var quote: ResearchQuote?
    public private(set) var holding: PortfolioHolding?
    public private(set) var brokers: [OpenAPI.Account] = []
    public private(set) var preferredBrokerId: AccountID?
    public private(set) var unitMath: TaxValue?
    public private(set) var isComputing = false
    public private(set) var isSubmitting = false
    public private(set) var hasUncertainWrite = false
    public private(set) var error: String?
    public private(set) var errorKey: String?
    public private(set) var noticeKey: String?
    public private(set) var notice: ScreenNotice?
    public private(set) var globalNoticesAttached = false
    @ObservationIgnored private var notices = NoticeCounter()
    public var brokerContext: (@MainActor (InvestmentID?) async -> ResearchMarketBrokerContext)?
    public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private var baselineInvestment = ResearchMarketInvestmentDraft()
    @ObservationIgnored private var baselineTrade = ResearchMarketTradeDraft()
    @ObservationIgnored private var numberFormat: NumberFormat = .eu
    @ObservationIgnored private var context = UUID()
    @ObservationIgnored private var mathRevision = UUID()
    @ObservationIgnored private var mathTask: Task<Void, Never>?
    @ObservationIgnored private let now: @Sendable () -> Date
    public init(service: any ResearchService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }
    public var isDirty: Bool { investment != baselineInvestment || trade != baselineTrade }
    public var assetClass: String {
        let type = quote?.type?.lowercased() ?? ""
        if type.contains("etf") { return "etf" }
        if type.contains("crypto") { return "crypto" }
        return "stock"
    }
    public var deriveUnits: Bool { ["buy", "sell"].contains(trade.type) }
    public var effectiveBrokerId: AccountID? {
        switch trade.broker {
        case .preferred: preferredBrokerId
        case .unassigned: nil
        case .account(let id): id
        }
    }
    public func configure(quote: ResearchQuote?, holding: PortfolioHolding?, numberFormat: NumberFormat) {
        let changesSymbol = self.quote?.symbol != quote?.symbol
        let changesBookingContext = self.holding?.id != holding?.id || self.holding?.currency != holding?.currency
        self.quote = quote
        self.holding = holding
        self.numberFormat = numberFormat
        if changesSymbol {
            context = UUID()
            discardDrafts()
        } else if changesBookingContext {
            // A delayed two-of-three response cannot authorize a trade in an earlier booking context.
            context = UUID()
        }
    }
    public func begin(notes: String) async {
        guard let quote, !isSubmitting else { return }
        if !isDirty { reset(quote: quote, notes: notes) }
        isPresented = true
        error = nil
        errorKey = nil
        let stamp = context
        if let value = await brokerContext?(holding?.id), stamp == context {
            brokers = value.accounts
            preferredBrokerId = value.preferredBrokerId
        }
        queueMath()
    }
    public func close() { isPresented = false }
    public func discardDrafts() {
        context = UUID()
        mathRevision = UUID()
        mathTask?.cancel()
        unitMath = nil
        isComputing = false
        investment = .init()
        trade = .init()
        baselineInvestment = investment
        baselineTrade = trade
        step = "choose"
        error = nil
        errorKey = nil
        isPresented = false
    }
    private func reset(quote: ResearchQuote, notes: String) {
        investment = .init()
        investment.name = quote.name ?? ""
        investment.currency = quote.currency
        investment.currentPrice = LocaleNumber.editable(quote.price, format: numberFormat)
        investment.notes = notes
        trade = .init()
        trade.date = Self.ymd(now())
        trade.price = LocaleNumber.editable(quote.price, format: numberFormat)
        baselineInvestment = investment
        baselineTrade = trade
        step = "choose"
    }
    public static func ymd(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: date)
    }
    private func positive(_ text: String) -> Decimal? {
        LocaleNumber.parse(text, format: numberFormat).flatMap { !$0.isNaN && $0 > 0 ? $0 : nil }
    }
    public var mathInput: TaxValue {
        var body: [String: TaxValue] = ["kind": .string("marketAdd"), "derive": .bool(deriveUnits)]
        for (key, text) in [("amount", trade.amount), ("units", trade.units), ("price", trade.price)] {
            if let value = positive(text) { body[key] = .number(value) }
        }
        return .object(body)
    }
    private func queueMath() {
        mathRevision = UUID()
        mathTask?.cancel()
        unitMath = nil
        isComputing = false
        guard quote != nil else { return }
        let stamp = mathRevision
        let body = mathInput
        mathTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 150_000_000) } catch { return }
            guard let self, stamp == mathRevision else { return }
            isComputing = true
            defer { if stamp == mathRevision { isComputing = false } }
            do {
                let result = try await service.researchPresentation(body)
                guard stamp == mathRevision, body == mathInput else { return }
                unitMath = try Self.mathResult(result)
            } catch { if stamp == mathRevision { self.error = error.localizedDescription } }
        }
    }
    private static func mathResult(_ raw: TaxValue) throws -> TaxValue {
        guard raw["kind"] == .string("marketAdd"), let result = raw["result"], result.objectValue != nil,
            result["isConsistent"]?.boolValue != nil, result["providedCount"]?.decimalValue != nil
        else { throw ResearchDecode.failure("Invalid market add presentation") }
        for key in [
            "effectiveAmount", "effectiveUnits", "effectivePrice", "derivedAmount", "derivedUnits", "derivedPrice",
        ] {
            if let raw = result[key],
                raw.decimalValue == nil || raw.decimalValue?.isNaN == true || (raw.decimalValue ?? 0) <= 0
            {
                throw ResearchDecode.failure("Invalid market add amount")
            }
        }
        return result
    }
    private func optionalNumber(_ text: String, positiveOnly: Bool = false) throws -> Decimal? {
        if text.isEmpty { return nil }
        guard let value = LocaleNumber.parse(text, format: numberFormat), !value.isNaN,
            positiveOnly ? value > 0 : value >= 0
        else {
            throw APIError.invalidRequest("addPortTxn.error.invalidNumber")
        }
        return value
    }
    public func createInvestment() async {
        guard let quote, !isSubmitting, !hasUncertainWrite else { return }
        let name = investment.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        var body: [String: TaxValue] = [
            "name": .string(name), "symbol": .string(quote.symbol.trimmingCharacters(in: .whitespacesAndNewlines)),
            "asset_class": .string(assetClass), "currency": .string(investment.currency),
            "price_provider": .string("yahoo"), "price_provider_id": .string(quote.symbol),
        ]
        if let price = positive(investment.currentPrice) { body["current_price"] = .number(price) }
        let note = investment.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !note.isEmpty { body["notes"] = .string(note) }
        isSubmitting = true
        defer { isSubmitting = false }
        await submit { [service] in _ = try await service.researchCreateInvestment(.object(body)) }
    }
    public func recordTransaction() async {
        guard let holding, !isSubmitting, !hasUncertainWrite else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        errorKey = nil
        error = nil
        guard !trade.date.isEmpty else {
            errorKey = "addPortTxn.error.dateRequired"
            return
        }
        let stamp = context
        let snapshot = trade
        let input = mathInput
        do {
            var amount = positive(trade.amount)
            var units = positive(trade.units)
            var price = positive(trade.price)
            if deriveUnits {
                let math = try Self.mathResult(try await service.researchPresentation(input))
                guard stamp == context, snapshot == trade else { return }
                unitMath = math
                guard math["isConsistent"] == .bool(true), let effective = math["effectiveAmount"]?.decimalValue else {
                    errorKey = "addPortTxn.error.twoOfThreeRequired"
                    return
                }
                amount = effective
                units = math["effectiveUnits"]?.decimalValue
                price = math["effectivePrice"]?.decimalValue
            }
            guard let amount else {
                errorKey = "addPortTxn.error.amountRequired"
                return
            }
            var body: [String: TaxValue] = [
                "type": .string(trade.type), "date": .string(trade.date), "amount": .number(amount),
                "currency": .string(holding.currency.rawValue),
                "dividend_amount_convention": .string(trade.type == "dividend" ? trade.dividendConvention : "unknown"),
                "is_recurring": .bool(trade.isRecurring),
            ]
            if let units { body["units"] = .number(units) }
            if let price { body["price_per_unit"] = .number(price) }
            for (key, text) in [("fees", trade.fees), ("taxes", trade.taxes), ("fx_rate_to_eur", trade.fx)] {
                if let value = try optionalNumber(text, positiveOnly: key == "fx_rate_to_eur") {
                    body[key] = .number(value)
                }
            }
            if let broker = effectiveBrokerId { body["account_id"] = .number(Decimal(broker.rawValue)) }
            let note = trade.note.trimmingCharacters(in: .whitespacesAndNewlines)
            if !note.isEmpty { body["note"] = .string(note) }
            if trade.isRecurring {
                body["recurrence_interval"] = .string(trade.recurrenceInterval)
                if !trade.recurrenceEndDate.isEmpty { body["recurrence_end_date"] = .string(trade.recurrenceEndDate) }
            }
            await submit { [service] in
                _ = try await service.researchCreateTransaction(investmentId: holding.id, input: .object(body))
            }
        } catch {
            if stamp == context {
                errorKey = "addPortTxn.error.invalidNumber"
                self.error = error.localizedDescription
            }
        }
    }
    private func submit(_ operation: () async throws -> Void) async {
        let stamp = context
        error = nil
        do {
            try await operation()
            await didMutate?()
            guard stamp == context else { return }
            noticeKey = step == "new" ? "addInv.toast.added" : "addPortTxn.toast.recorded"
            notice = notices.make(
                .success, noticeKey!, ["name": quote?.symbol ?? "", "assetClass": assetClass, "type": trade.type])
            discardDrafts()
        } catch {
            if case APIError.client(let client) = error, (400..<500).contains(client.status) {
            } else if case APIError.invalidRequest = error {
            } else {
                hasUncertainWrite = true
            }
            // Refresh holdings after an ambiguous write; never automatically repeat the POST.
            await didMutate?()
            if stamp == context { self.error = error.localizedDescription }
        }
    }
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
        globalNoticesAttached = true
    }

    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    public func acknowledgeUncertainWrite() async {
        guard !isSubmitting else { return }
        await didMutate?()
        hasUncertainWrite = false
    }
}
