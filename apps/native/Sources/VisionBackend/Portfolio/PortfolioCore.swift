import Foundation

/// The portfolio math shared by the Vision backend and frontend
/// (`packages/shared-utils/src/portfolio.ts`): cost-basis accounting
/// (weighted average / FIFO / LIFO), fixed-income interest accrual, the
/// per-investment summary core, and the ADR-108 partitioned wrapper over it.
/// Pure functions only — "today" and the FX multipliers are inputs.
///
/// JS `sort` is stable, so every sort here carries the original index as its
/// last key; `localeCompare` on the corpus's ASCII dates is the UTF-16
/// code-unit order. `dividedBy` never fails on these paths (each call site
/// guards like the TS engine does), so the division helper folds the
/// impossible error into a defensive zero.
enum PortfolioCore {
    /// The error the TS engine's guards throw; the message is the TS one.
    struct Failure: Error, Equatable, Sendable, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    static let costBasisMethods: [String] = ["weighted_avg", "fifo", "lifo"]
    static func isCostBasisMethod(_ value: String) -> Bool { costBasisMethods.contains(value) }

    static let unitBasedClasses: Set<String> = ["stock", "etf", "crypto", "metals"]
    static let fixedIncomeClasses: Set<String> = ["savings", "bond"]
    static let realEstateClass = "real_estate"
    /// The wire transaction types the engine dispatches on (ADR-270 names).
    enum TxnKind: String {
        case buy, gift, sell
        case fee, tax, dividend, interest
        case rentIncome = "rent_income"
        case appreciation
        case returnOfCapital = "return_of_capital"
        case split, merger, spinoff
        case transferIn = "transfer_in"
        case transferOut = "transfer_out"
        case assetFee = "asset_fee"
        case unitReversal = "unit_reversal"
        case assetTransfer = "asset_transfer"
        case assetAdjustment = "asset_adjustment"
        /// Any wire type the replay treats as a no-op.
        case other
    }

    /// The cost-basis method setting values.
    enum CostMethod: String {
        case weightedAvg = "weighted_avg"
        case fifo, lifo
    }

    /// A corporate action of a custody adjustment (`adjustment_kind`).
    enum AdjustmentKind: String {
        case yieldReversal = "yield_reversal"
        case assetFee = "asset_fee"
    }

    /// A custody adjustment's `basis_policy`.
    enum BasisPolicy: String {
        case zeroYieldOnly = "zero_yield_only"
        case carried
    }

    static let euroCurrency = "EUR"

    /// `income_recognition_role` values.
    static let includedInUnitsRole = "included_in_units"

    static let lotTxnTypes: Set<String> = [
        "buy", "gift", "sell", "transfer_in", "transfer_out", "asset_fee", "unit_reversal",
    ]

    // MARK: - Inputs

    /// A `TxnNumeric` as it arrives: a JavaScript number, decimal text, an
    /// exact Decimal, or `null` (JS `undefined` and `""` read as zero).
    enum Numeric: Equatable, Sendable {
        case number(Double)
        case text(String)
        case decimal(DecimalJS)
        case null

        /// `toDecimal(v)` of `money.ts`.
        var decimal: DecimalJS {
            switch self {
            case .number(let value): return (try? DecimalJS(value)) ?? .zero
            case .text(let text): return (try? DecimalJS.from(text)) ?? .zero
            case .decimal(let value): return value
            case .null: return .zero
            }
        }

        /// `isNonZeroNumber` of `lib/numeric.ts`.
        var isNonZeroNumber: Bool {
            if case .number(let value) = self {
                return value.isFinite && value != 0
            }
            return false
        }
    }

    /// One row the engines replay: a stored transaction or a custody leg.
    struct Txn: Sendable {
        /// `id` compared as `Number(a.id ?? 0)`.
        var id: Double?
        var type: String
        var date: String
        var fxMultiplier: Numeric?
        var nativeFxMultiplier: Numeric?
        var nativeCurrency: String?  // lint:allow raw-currency the transaction's raw wire currency, passed through unvalidated
        var units: Numeric
        var amount: Numeric
        var fees: Numeric
        var taxes: Numeric
        var incomeRecognitionRole: String?
        // Custody projections only.
        var accountId: Double?
        var sourceAccountId: Double?
        var destinationAccountId: Double?
        var feeUnits: Numeric = .null
        var adjustmentKind: String?
        var basisPolicy: String?
        var eligibleSourceRecordHashes: [String?] = []
        var sourceRecordHash: String?
        var currency: String?
        var transferredBasis: DecimalJS?
        var transferredBasisConv: DecimalJS?
        var transferredLots: [CustodyLot] = []
        var assetFeeBasis: DecimalJS?
        var assetFeeBasisConv: DecimalJS?
        var consumedLots: [CustodyLot] = []

        init(
            id: Double? = nil, type: String, date: String,
            fxMultiplier: Numeric? = nil, nativeFxMultiplier: Numeric? = nil,
            nativeCurrency: String? = nil, units: Numeric = .null, amount: Numeric = .null,  // lint:allow raw-currency the transaction's raw wire currency, passed through unvalidated
            fees: Numeric = .null, taxes: Numeric = .null, incomeRecognitionRole: String? = nil,
            accountId: Double? = nil, sourceAccountId: Double? = nil, destinationAccountId: Double? = nil,
            feeUnits: Numeric = .null, adjustmentKind: String? = nil, basisPolicy: String? = nil,
            eligibleSourceRecordHashes: [String?] = [], sourceRecordHash: String? = nil,
            currency: String? = nil
        ) {
            self.id = id
            self.type = type
            self.date = date
            self.fxMultiplier = fxMultiplier
            self.nativeFxMultiplier = nativeFxMultiplier
            self.nativeCurrency = nativeCurrency
            self.units = units
            self.amount = amount
            self.fees = fees
            self.taxes = taxes
            self.incomeRecognitionRole = incomeRecognitionRole
            self.accountId = accountId
            self.sourceAccountId = sourceAccountId
            self.destinationAccountId = destinationAccountId
            self.feeUnits = feeUnits
            self.adjustmentKind = adjustmentKind
            self.basisPolicy = basisPolicy
            self.eligibleSourceRecordHashes = eligibleSourceRecordHashes
            self.sourceRecordHash = sourceRecordHash
            self.currency = currency
        }

        /// The dispatch kind of `type`; an unrecognized wire type replays as a no-op.
        var kind: TxnKind { TxnKind(rawValue: type) ?? .other }
    }

    /// A lot held by the lot engines or moved by a custody projection.
    struct CustodyLot: Sendable {
        var acquisitionType: String?
        var sourceRecordHash: String?
        var units: DecimalJS
        var costBasis: DecimalJS
        var costBasisConv: DecimalJS
        var acquiredDate: String
        var acquisitionId: Double
        var currency: String?
        var fxResolved: Bool
    }

    /// The investment columns the core reads.
    struct Investment: Sendable {
        var assetClass: String
        var currentPrice: Numeric = .null
        var interestRate: Numeric = .null
    }

    struct Options: Sendable {
        var costBasisMethod: String = "weighted_avg"
        var todayYmd: String = ""
        var fxMultiplierNow: Numeric? = .number(1)
    }

    struct BasisOptions: Sendable {
        var defaultFxMultiplier: Numeric? = .number(1)
    }

    struct Args: Sendable {
        var inv: Investment
        var txns: [Txn]
        var opts: Options = Options()
    }

    // MARK: JS-shaped helpers

    static func jsNumber(_ value: DecimalJS) -> Double { value.toNumber }
    static func number(_ value: Double?) -> Double { value ?? 0 }
    static func min(_ a: DecimalJS, _ b: DecimalJS) -> DecimalJS { a.lte(b) ? a : b }
    static func div(_ a: DecimalJS, _ b: DecimalJS) -> DecimalJS { (try? a.dividedBy(b)) ?? .zero }
    static func decimal(_ numeric: Numeric?) -> DecimalJS {
        guard let numeric else { return .zero }
        return numeric.decimal
    }
    /// `toDecimal(txn.nativeFxMultiplier ?? 1)` and friends: a present value
    /// over its own digits, an absent one exactly 1.
    static func fxDecimal(_ numeric: Numeric?) -> DecimalJS {
        guard let numeric else { return .one }
        return numeric.decimal
    }
    static func isNonZeroNumber(_ value: Double) -> Bool { value.isFinite && value != 0 }

    /// `Number(value)` of a free-typed investment column (a quoted rate parses).
    static func jsToNumber(_ numeric: Numeric) -> Double {
        switch numeric {
        case .number(let value): return value
        case .text(let text): return JavaScriptNumber.fromString(text)
        case .decimal(let value): return value.toNumber
        case .null: return 0
        }
    }
    static func toDecimal(_ value: Double) -> DecimalJS { (try? DecimalJS(value)) ?? .zero }

    /// The engine's fxMultiplier read: an absent value means the caller's
    /// default (the summary passes `mNow`, the flat basis opts' 1).
    static func txnFx(_ txn: Txn, _ defaultFx: DecimalJS) -> DecimalJS {
        guard let fx = txn.fxMultiplier else { return defaultFx }
        return fx.decimal
    }

    /// `[...txns].sort((a, b) => a.date.localeCompare(b.date))` — JS sort is
    /// stable, so the original index breaks ties.
    static func stableDateSort(_ txns: [Txn]) -> [Txn] {
        txns.enumerated().sorted { left, right in
            let byDate = left.element.date.utf16Compare(right.element.date)
            if byDate != 0 { return byDate < 0 }
            return left.offset < right.offset
        }.map(\.element)
    }

    /// The date-then-`Number(id ?? 0)` sort, stable on the original index.
    static func stableDateIdSort(_ txns: [Txn]) -> [Txn] {
        txns.enumerated().sorted { left, right in
            let byDate = left.element.date.utf16Compare(right.element.date)
            if byDate != 0 { return byDate < 0 }
            let byId = number(left.element.id) - number(right.element.id)
            if byId != 0 { return byId < 0 }
            return left.offset < right.offset
        }.map(\.element)
    }

    static func acquisitionCompare(_ a: CustodyLot, _ b: CustodyLot) -> Bool {
        let byDate = a.acquiredDate.utf16Compare(b.acquiredDate)
        if byDate != 0 { return byDate < 0 }
        return a.acquisitionId < b.acquisitionId
    }

    // MARK: - Dates

    /// `daysBetweenYmd`: whole UTC days between two YYYY-MM-DD strings, with
    /// `Date.UTC` on both ends and JS's missing-part semantics (a missing
    /// piece stays undefined and the whole result is NaN).
    static func daysBetweenYmd(_ fromYmd: String, _ toYmd: String) -> Double {
        let difference = utcMs(toYmd) - utcMs(fromYmd)
        return (difference / 86_400_000).rounded()
    }

    /// `Date.UTC(y, m - 1, d)`, with the JS coercion of missing parts;
    /// a missing piece answers the NaN of the whole expression.
    private static func utcMs(_ ymd: String) -> Double {
        let text = String(ymd.prefix(10))
        let pieces = text.split(separator: "-", omittingEmptySubsequences: false)
        func number(_ piece: Substring?) -> Double {
            guard let piece, !piece.isEmpty else { return .nan }
            guard let value = Double(piece) else { return .nan }
            return value
        }
        let year = number(pieces.count > 0 ? pieces[0] : nil)
        let month = number(pieces.count > 1 ? pieces[1] : nil)
        let day = number(pieces.count > 2 ? pieces[2] : nil)
        var components = DateComponents()
        components.year = Int(exactly: year)
        components.month = Int(exactly: month)
        components.day = Int(exactly: day)
        guard let date = Calendar.utc.date(from: components) else { return .nan }
        return date.timeIntervalSince1970 * 1000
    }

    // MARK: - Cost basis

    /// `CostBasisResult`: each sum through `roundToCents` except `totalUnits`
    /// and the two averages, which stay unrounded as the TS emits them.
    struct CostBasisResult: Equatable, Sendable {
        var totalUnits: Double
        var totalCost: Double
        var avgCostBasis: Double
        var realizedGain: Double
        var totalBuyCost: Double
        var totalSellProceeds: Double
        var totalCostConv: Double
        var avgCostBasisConv: Double
        var realizedGainConv: Double
        var totalBuyCostConv: Double
        var totalSellProceedsConv: Double
        var oversold: Bool

        init(cents: (DecimalJS, DecimalJS, DecimalJS, DecimalJS, DecimalJS, DecimalJS, DecimalJS, DecimalJS),
             units: DecimalJS, avg: DecimalJS, avgConv: DecimalJS, oversold: Bool) {
            totalUnits = jsNumber(units)
            totalCost = jsNumber(cents.0.toDecimalPlaces(2))
            avgCostBasis = jsNumber(avg)
            realizedGain = jsNumber(cents.1.toDecimalPlaces(2))
            totalBuyCost = jsNumber(cents.2.toDecimalPlaces(2))
            totalSellProceeds = jsNumber(cents.3.toDecimalPlaces(2))
            totalCostConv = jsNumber(cents.4.toDecimalPlaces(2))
            avgCostBasisConv = jsNumber(avgConv)
            realizedGainConv = jsNumber(cents.5.toDecimalPlaces(2))
            totalBuyCostConv = jsNumber(cents.6.toDecimalPlaces(2))
            totalSellProceedsConv = jsNumber(cents.7.toDecimalPlaces(2))
            self.oversold = oversold
        }

        /// `toDecimal(cb.…)` of the summary core, which re-reads the result.
        var unitsDecimal: DecimalJS { toDecimal(totalUnits) }
        var avgCostBasisDecimal: DecimalJS { toDecimal(avgCostBasis) }
        var totalBuyCostDecimal: DecimalJS { toDecimal(totalBuyCost) }
        var totalSellProceedsDecimal: DecimalJS { toDecimal(totalSellProceeds) }
        var totalCostDecimal: DecimalJS { toDecimal(totalCost) }
        var realizedGainDecimal: DecimalJS { toDecimal(realizedGain) }
        var avgCostBasisConvDecimal: DecimalJS { toDecimal(avgCostBasisConv) }
        var totalBuyCostConvDecimal: DecimalJS { toDecimal(totalBuyCostConv) }
        var totalSellProceedsConvDecimal: DecimalJS { toDecimal(totalSellProceedsConv) }
        var totalCostConvDecimal: DecimalJS { toDecimal(totalCostConv) }
        var realizedGainConvDecimal: DecimalJS { toDecimal(realizedGainConv) }
    }

    /// `present` of `portfolio.ts`: a projected leg the replay was promised.
    static func present(_ value: DecimalJS?, _ what: String) throws -> DecimalJS {
        guard let value else { throw Failure(message: "Expected \(what) to be present") }
        return value
    }

    /// `present` for the lot lists a projected leg carries.
    static func present(_ value: [CustodyLot], _ what: String) throws -> [CustodyLot] {
        guard value.count > 0 else { throw Failure(message: "Expected \(what) to be present") }
        return value
    }

    /// `calculateCostBasis`: the moving weighted-average engine.
    static func calculateCostBasis(_ txns: [Txn], opts: BasisOptions = BasisOptions()) throws -> CostBasisResult {
        let sorted = stableDateIdSort(txns)
        let ZERO = DecimalJS.zero
        let defaultFx = opts.defaultFxMultiplier.map(\.decimal) ?? .one
        var totalUnits = ZERO
        var totalCost = ZERO
        var totalCostConv = ZERO
        var realizedGain = ZERO
        var realizedGainConv = ZERO
        var totalBuyCost = ZERO
        var totalBuyCostConv = ZERO
        var totalSellProceeds = ZERO
        var totalSellProceedsConv = ZERO
        var oversold = false

        for txn in sorted {
            let units = txn.units.decimal
            let amount = txn.amount.decimal
            let fees = txn.fees.decimal
            let taxes = txn.taxes.decimal
            let fx = txnFx(txn, defaultFx)
            let nativeFx = fxDecimal(txn.nativeFxMultiplier)

            switch txn.kind {
            case .buy, .gift:
                let buyCost = amount.plus(fees).plus(taxes)
                totalUnits = totalUnits.plus(units)
                totalCost = totalCost.plus(buyCost.times(nativeFx))
                totalCostConv = totalCostConv.plus(buyCost.times(fx))
                totalBuyCost = totalBuyCost.plus(buyCost.times(nativeFx))
                totalBuyCostConv = totalBuyCostConv.plus(buyCost.times(fx))
            case .transferIn:
                totalUnits = totalUnits.plus(units)
                totalCost = totalCost.plus(try present(txn.transferredBasis, "transferredBasis"))
                totalCostConv = totalCostConv.plus(try present(txn.transferredBasisConv, "transferredBasisConv"))
            case .transferOut, .assetFee, .unitReversal:
                totalUnits = totalUnits.minus(units)
                totalCost = totalCost.minus(try present(txn.transferredBasis, "transferredBasis"))
                totalCostConv = totalCostConv.minus(try present(txn.transferredBasisConv, "transferredBasisConv"))
                realizedGain = realizedGain.minus(txn.assetFeeBasis ?? ZERO)
                realizedGainConv = realizedGainConv.minus(txn.assetFeeBasisConv ?? ZERO)
            case .sell:
                if units.gt(totalUnits) { oversold = true }
                if totalUnits.gt(ZERO), units.gt(ZERO) {
                    let sellUnits = min(units, totalUnits)
                    let sellRatio = div(sellUnits, units)
                    let avgCost = div(totalCost, totalUnits)
                    let costOfSoldUnits = avgCost.times(sellUnits)
                    let costOfSoldConv = div(totalCostConv.times(sellUnits), totalUnits)
                    let netProceedsPlus = amount.minus(fees).minus(taxes).times(sellRatio)
                    realizedGain = realizedGain.plus(netProceedsPlus.times(nativeFx).minus(costOfSoldUnits))
                    realizedGainConv = realizedGainConv.plus(netProceedsPlus.times(fx).minus(costOfSoldConv))
                    totalUnits = totalUnits.minus(sellUnits)
                    totalCost = totalCost.minus(costOfSoldUnits)
                    totalCostConv = totalCostConv.minus(costOfSoldConv)
                    totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio).times(nativeFx))
                    totalSellProceedsConv = totalSellProceedsConv.plus(amount.times(sellRatio).times(fx))
                }
            case .split:
                if totalUnits.gt(ZERO), units.gt(ZERO) { totalUnits = units }
            case .returnOfCapital:
                if totalUnits.gt(ZERO) {
                    let reducedPlus = DecimalJS.max(ZERO, totalCost.minus(amount.times(nativeFx)))
                    let factor = totalCost.gt(ZERO) ? div(reducedPlus, totalCost) : ZERO
                    totalCost = reducedPlus
                    totalCostConv = totalCostConv.times(factor)
                }
            default:
                break
            }
        }

        let finalUnits = DecimalJS.max(ZERO, totalUnits)
        let finalCost = DecimalJS.max(ZERO, totalCost)
        let finalCostConv = DecimalJS.max(ZERO, totalCostConv)
        return CostBasisResult(
            cents: (finalCost, realizedGain, totalBuyCost, totalSellProceeds,
                    finalCostConv, realizedGainConv, totalBuyCostConv, totalSellProceedsConv),
            units: finalUnits,
            avg: finalUnits.gt(ZERO) ? div(finalCost, finalUnits) : ZERO,
            avgConv: finalUnits.gt(ZERO) ? div(finalCostConv, finalUnits) : ZERO,
            oversold: oversold)
    }

    /// The shared lot engine of FIFO and LIFO; `fromEnd` consumes the tail.
    private static func calculateCostBasisLotBased(
        _ txns: [Txn], opts: BasisOptions, fromEnd: Bool
    ) throws -> CostBasisResult {
        let sorted = stableDateSort(txns)
        let ZERO = DecimalJS.zero
        let defaultFx = opts.defaultFxMultiplier.map(\.decimal) ?? .one
        var lots: [CustodyLot] = []
        var head = 0
        var totalUnits = ZERO
        var realizedGain = ZERO
        var realizedGainConv = ZERO
        var totalBuyCost = ZERO
        var totalBuyCostConv = ZERO
        var totalSellProceeds = ZERO
        var totalSellProceedsConv = ZERO
        var oversold = false

        for txn in sorted {
            let units = txn.units.decimal
            let amount = txn.amount.decimal
            let fees = txn.fees.decimal
            let taxes = txn.taxes.decimal
            let fx = txnFx(txn, defaultFx)
            let nativeFx = fxDecimal(txn.nativeFxMultiplier)

            switch txn.kind {
            case .buy, .gift:
                let buyCost = amount.plus(fees).plus(taxes)
                lots.append(CustodyLot(
                    acquisitionType: txn.type, sourceRecordHash: nil,
                    units: units, costBasis: buyCost.times(nativeFx),
                    costBasisConv: buyCost.times(fx), acquiredDate: txn.date,
                    acquisitionId: number(txn.id), currency: nil, fxResolved: true))
                totalUnits = totalUnits.plus(units)
                totalBuyCost = totalBuyCost.plus(buyCost.times(nativeFx))
                totalBuyCostConv = totalBuyCostConv.plus(buyCost.times(fx))
            case .transferIn:
                lots = head > 0 ? Array(lots[head...]) : lots
                head = 0
                lots.append(contentsOf: try present(txn.transferredLots, "transferredLots"))
                lots.sort(by: acquisitionCompare)
                totalUnits = totalUnits.plus(units)
            case .unitReversal:
                lots = head > 0 ? Array(lots[head...]) : lots
                head = 0
                for consumed in try present(txn.consumedLots, "consumedLots") {
                    var remaining = consumed.units
                    for indexL in lots.indices {
                        if remaining.lte(ZERO) { break }
                        let lot = lots[indexL]
                        if lot.acquisitionId != consumed.acquisitionId
                            || lot.acquiredDate != consumed.acquiredDate
                            || lot.acquisitionType != TxnKind.gift.rawValue
                            || !lot.costBasis.eq(ZERO)
                        { continue }
                        let removed = min(remaining, lot.units)
                        lots[indexL].units = lot.units.minus(removed)
                        remaining = remaining.minus(removed)
                    }
                    if remaining.gt(ZERO) {
                        throw Failure(message: "Yield reversal allocation no longer matches its original lots")
                    }
                }
                lots.removeAll { !$0.units.gt(ZERO) }
                totalUnits = totalUnits.minus(units)
            case .sell where units.gt(ZERO), .transferOut, .assetFee:
                if units.gt(totalUnits) { oversold = true }
                let sellUnits = min(units, totalUnits)
                let sellRatio = units.gt(ZERO) ? div(sellUnits, units) : ZERO
                let netProceeds = amount.minus(fees).minus(taxes).times(sellRatio)
                var unitsToSell = sellUnits
                var costOfSold = ZERO
                var costOfSoldConv = ZERO

                while unitsToSell.gt(ZERO), head < lots.count {
                    let idx = fromEnd ? lots.count - 1 : head
                    let lot = lots[idx]
                    if lot.units.lte(unitsToSell) {
                        costOfSold = costOfSold.plus(lot.costBasis)
                        costOfSoldConv = costOfSoldConv.plus(lot.costBasisConv)
                        unitsToSell = unitsToSell.minus(lot.units)
                        if fromEnd { _ = lots.popLast() } else { head += 1 }
                    } else {
                        let fraction = div(unitsToSell, lot.units)
                        let lotCostUsed = lot.costBasis.times(fraction)
                        let lotCostUsedConv = lot.costBasisConv.times(fraction)
                        costOfSold = costOfSold.plus(lotCostUsed)
                        costOfSoldConv = costOfSoldConv.plus(lotCostUsedConv)
                        lots[idx].units = lot.units.minus(unitsToSell)
                        lots[idx].costBasis = lot.costBasis.minus(lotCostUsed)
                        lots[idx].costBasisConv = lot.costBasisConv.minus(lotCostUsedConv)
                        unitsToSell = ZERO
                    }
                }

                totalUnits = totalUnits.minus(sellUnits)
                if txn.kind == .transferOut || txn.kind == .assetFee {
                    realizedGain = realizedGain.minus(txn.assetFeeBasis ?? ZERO)
                    realizedGainConv = realizedGainConv.minus(txn.assetFeeBasisConv ?? ZERO)
                    continue
                }
                realizedGain = realizedGain.plus(netProceeds.times(nativeFx).minus(costOfSold))
                realizedGainConv = realizedGainConv.plus(netProceeds.times(fx).minus(costOfSoldConv))
                totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio).times(nativeFx))
                totalSellProceedsConv = totalSellProceedsConv.plus(amount.times(sellRatio).times(fx))
            case .split, .merger, .spinoff, .returnOfCapital:
                let activeLots = head > 0 ? Array(lots[head...]) : lots
                let applied = applyEventToLots(
                    activeLots, txn.kind, units, amount.times(nativeFx), totalUnits)
                totalUnits = applied.totalUnits
                lots = applied.lots
                head = 0
            default:
                break
            }
        }

        let activeLots = head > 0 ? Array(lots[head...]) : lots
        let totalCost = activeLots.reduce(ZERO) { $0.plus($1.costBasis) }
        let totalCostConv = activeLots.reduce(ZERO) { $0.plus($1.costBasisConv) }
        let finalUnits = DecimalJS.max(ZERO, totalUnits)
        let finalCost = DecimalJS.max(ZERO, totalCost)
        let finalCostConv = DecimalJS.max(ZERO, totalCostConv)
        return CostBasisResult(
            cents: (finalCost, realizedGain, totalBuyCost, totalSellProceeds,
                    finalCostConv, realizedGainConv, totalBuyCostConv, totalSellProceedsConv),
            units: finalUnits,
            avg: finalUnits.gt(ZERO) ? div(finalCost, finalUnits) : ZERO,
            avgConv: finalUnits.gt(ZERO) ? div(finalCostConv, finalUnits) : ZERO,
            oversold: oversold)
    }

    static func calculateCostBasisFIFO(_ txns: [Txn], opts: BasisOptions = BasisOptions()) throws -> CostBasisResult {
        try calculateCostBasisLotBased(txns, opts: opts, fromEnd: false)
    }

    static func calculateCostBasisLIFO(_ txns: [Txn], opts: BasisOptions = BasisOptions()) throws -> CostBasisResult {
        try calculateCostBasisLotBased(txns, opts: opts, fromEnd: true)
    }

    static func calculateCostBasisByMethod(
        _ txns: [Txn], _ method: String?, opts: BasisOptions = BasisOptions()
    ) throws -> CostBasisResult {
        switch CostMethod(rawValue: method ?? "") {
        case .fifo: return try calculateCostBasisFIFO(txns, opts: opts)
        case .lifo: return try calculateCostBasisLIFO(txns, opts: opts)
        default: return try calculateCostBasis(txns, opts: opts)
        }
    }

    /// `applyEventToLots`: corporate actions over a lot array.
    private static func applyEventToLots(
        _ lots: [CustodyLot], _ kind: TxnKind, _ units: DecimalJS, _ amount: DecimalJS,
        _ totalUnits: DecimalJS
    ) -> (totalUnits: DecimalJS, lots: [CustodyLot]) {
        let ZERO = DecimalJS.zero
        if kind == .split, totalUnits.gt(ZERO), units.gt(ZERO) {
            let ratio = div(units, totalUnits)
            return (units, lots.map { lot in
                var rescaled = lot
                rescaled.units = lot.units.times(ratio)
                return rescaled
            })
        }
        if kind == .returnOfCapital, totalUnits.gt(ZERO) {
            let reductionPerUnit = div(amount, totalUnits)
            return (totalUnits, lots.map { lot in
                let reducedPlus = DecimalJS.max(ZERO, lot.costBasis.minus(reductionPerUnit.times(lot.units)))
                let factor = lot.costBasis.gt(ZERO) ? div(reducedPlus, lot.costBasis) : ZERO
                var reduced = lot
                reduced.costBasis = reducedPlus
                reduced.costBasisConv = lot.costBasisConv.times(factor)
                return reduced
            })
        }
        return (totalUnits, lots)
    }

    // MARK: - Fixed-income accrual

    /// `PRINCIPAL_DIRECTION`.
    private static let principalDirection: [String: Int] = [
        "buy": 1, "gift": 1, "sell": -1, "return_of_capital": -1,
    ]

    /// `calculateAccruedInterest`: per-principal-segment simple interest.
    static func calculateAccruedInterest(
        _ txns: [Txn], _ principal: Double, _ interestRate: Numeric, _ todayYmd: String
    ) -> Double {
        guard case .number(let rate) = interestRate, isNonZeroNumber(rate), principal > 0 else { return 0 }

        func ymdOf(_ date: String) -> String { String(date.prefix(10)) }
        // `[...txns].sort(b.date.localeCompare(a.date))`: date descending, stable.
        let sortedDesc = txns.enumerated().sorted { left, right in
            let byDate = right.element.date.utf16Compare(left.element.date)
            if byDate != 0 { return byDate < 0 }
            return left.offset < right.offset
        }.map(\.element)
        let lastInterestTxn = sortedDesc.first { $0.kind == .interest }
        var sortedAsc = stableDateSort(txns).filter { $0.kind == .buy }
        guard let startRaw = lastInterestTxn?.date ?? sortedAsc.first?.date else { return 0 }
        let startDate = ymdOf(startRaw)

        let ZERO = DecimalJS.zero
        var segmentPrincipal = toDecimal(principal)
        var segmentEnd = todayYmd
        var principalDays = ZERO
        for txn in sortedDesc {
            guard let direction = principalDirection[txn.type] else { continue }
            let at = ymdOf(txn.date)
            if at.utf16Compare(startDate) <= 0 { continue }
            if at.utf16Compare(segmentEnd) < 0 {
                principalDays = principalDays.plus(
                    DecimalJS.max(segmentPrincipal, ZERO).times(toDecimal(daysBetweenYmd(at, segmentEnd))))
                segmentEnd = at
            }
            let change = txn.amount.decimal.times(fxDecimal(txn.nativeFxMultiplier))
            segmentPrincipal = segmentPrincipal.minus(change.times(toDecimal(Double(direction))))
        }
        if startDate.utf16Compare(segmentEnd) < 0 {
            principalDays = principalDays.plus(
                DecimalJS.max(segmentPrincipal, ZERO).times(toDecimal(daysBetweenYmd(startDate, segmentEnd))))
        }
        return jsNumber(principalDays.times(div(div(toDecimal(rate), toDecimal(100)), toDecimal(365))))
    }

    /// `projectedAnnualInterest`.
    static func projectedAnnualInterest(_ principal: Double, _ ratePercent: Numeric) -> Double {
        guard case .number(let rate) = ratePercent, isNonZeroNumber(rate), !(principal <= 0) else { return 0 }
        if !principal.isFinite { return principal }
        return jsNumber(toDecimal(principal).times(div(toDecimal(rate), toDecimal(100))))
    }

    // MARK: - The summary core

    struct ConvertedTrack: Sendable {
        var currentValue = DecimalJS.zero
        var totalInvested = DecimalJS.zero
        var totalBuyCost = DecimalJS.zero
        var totalSellProceeds = DecimalJS.zero
        var avgCostBasis = DecimalJS.zero
        var realizedGain = DecimalJS.zero
        var unrealizedGain = DecimalJS.zero
        var totalGain = DecimalJS.zero
        var gainLoss = DecimalJS.zero
        var gainLossPercent = DecimalJS.zero
        var assetGain = DecimalJS.zero
        var fxGain = DecimalJS.zero
        var totalFees = DecimalJS.zero
        var totalTaxes = DecimalJS.zero
        var totalDividends = DecimalJS.zero
        var totalInKindIncome = DecimalJS.zero
        var totalIncome = DecimalJS.zero
    }

    struct SummaryCore: Sendable {
        var totalUnits = DecimalJS.zero
        var avgCostBasis = DecimalJS.zero
        var totalInvested = DecimalJS.zero
        var totalBuyCost = DecimalJS.zero
        var totalSellProceeds = DecimalJS.zero
        var currentValue = DecimalJS.zero
        var realizedGain = DecimalJS.zero
        var unrealizedGain = DecimalJS.zero
        var totalGain = DecimalJS.zero
        var gainLoss = DecimalJS.zero
        var gainLossPercent = DecimalJS.zero
        var totalFees = DecimalJS.zero
        var totalTaxes = DecimalJS.zero
        var feeTxnAmount = DecimalJS.zero
        var taxTxnAmount = DecimalJS.zero
        var totalDividends = DecimalJS.zero
        var totalInKindIncome = DecimalJS.zero
        var totalInterestPaid = DecimalJS.zero
        var totalRent = DecimalJS.zero
        var totalAppreciation = DecimalJS.zero
        var totalIncome = DecimalJS.zero
        var accruedInterest = DecimalJS.zero
        var projectedAnnualInterest = DecimalJS.zero
        var oversold = false
        var converted = ConvertedTrack()
    }

    /// `buildInvestmentSummaryCore` — the calculation half of the backend's
    /// `buildInvestmentSummary` and the frontend's `buildSummary`, in the
    /// investment's native currency, with the converted track in target
    /// currency at transaction-date rates.
    static func buildInvestmentSummaryCore(_ inv: Investment, _ txns: [Txn], opts: Options) throws -> SummaryCore {
        let method = isCostBasisMethod(opts.costBasisMethod) ? opts.costBasisMethod : "weighted_avg"
        let todayYmd = opts.todayYmd
        let isUnitBased = unitBasedClasses.contains(inv.assetClass)
        let isFixedIncome = fixedIncomeClasses.contains(inv.assetClass)
        let isRealEstate = inv.assetClass == realEstateClass

        let ZERO = DecimalJS.zero
        let mNow = (opts.fxMultiplierNow ?? .number(1)).decimal

        var totalDividends = ZERO
        var totalInKindIncome = ZERO
        var totalInterestPaid = ZERO
        var totalRent = ZERO
        var totalAppreciation = ZERO
        var totalBuyAmount = ZERO
        var totalBuyOrGiftAmount = ZERO
        var totalSellAmount = ZERO
        var totalReturnOfCapital = ZERO
        var feeTxnAmount = ZERO
        var taxTxnAmount = ZERO
        var feesFieldAmount = ZERO
        var taxesFieldAmount = ZERO
        var nonBasisExpenses = ZERO

        var totalDividendsC = ZERO
        var totalInKindIncomeC = ZERO
        var totalInterestPaidC = ZERO
        var totalRentC = ZERO
        var totalBuyAmountC = ZERO
        var totalBuyOrGiftAmountC = ZERO
        var totalSellAmountC = ZERO
        var totalReturnOfCapitalC = ZERO
        var feeTxnAmountC = ZERO
        var taxTxnAmountC = ZERO
        var feesFieldAmountC = ZERO
        var taxesFieldAmountC = ZERO
        var nonBasisExpensesC = ZERO

        for txn in txns {
            let incomeRole = txn.incomeRecognitionRole ?? "standard"
            if incomeRole != "standard" && incomeRole != "included_in_units" {
                throw Failure(message: "Unsupported portfolio income recognition role")
            }
            if incomeRole == PortfolioCore.includedInUnitsRole && (txn.type != "dividend" || !isUnitBased) {
                throw Failure(message: "In-kind income requires a unit-based dividend")
            }
            let rawAmount = txn.amount.decimal
            let nativeFx = fxDecimal(txn.nativeFxMultiplier)
            let amount = rawAmount.times(nativeFx)
            let fx = txnFx(txn, mNow)
            feesFieldAmount = feesFieldAmount.plus(txn.fees.decimal.times(nativeFx))
            taxesFieldAmount = taxesFieldAmount.plus(txn.taxes.decimal.times(nativeFx))
            feesFieldAmountC = feesFieldAmountC.plus(txn.fees.decimal.times(fx))
            taxesFieldAmountC = taxesFieldAmountC.plus(txn.taxes.decimal.times(fx))
            if !lotTxnTypes.contains(txn.type) {
                let expenses = txn.fees.decimal.plus(txn.taxes.decimal)
                nonBasisExpenses = nonBasisExpenses.plus(expenses.times(nativeFx))
                nonBasisExpensesC = nonBasisExpensesC.plus(expenses.times(fx))
            }

            switch txn.kind {
            case .buy:
                totalBuyAmount = totalBuyAmount.plus(amount)
                totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount)
                totalBuyAmountC = totalBuyAmountC.plus(rawAmount.times(fx))
                totalBuyOrGiftAmountC = totalBuyOrGiftAmountC.plus(rawAmount.times(fx))
            case .gift:
                totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount)
                totalBuyOrGiftAmountC = totalBuyOrGiftAmountC.plus(rawAmount.times(fx))
            case .sell:
                totalSellAmount = totalSellAmount.plus(amount)
                totalSellAmountC = totalSellAmountC.plus(rawAmount.times(fx))
            case .fee:
                feeTxnAmount = feeTxnAmount.plus(amount)
                feeTxnAmountC = feeTxnAmountC.plus(rawAmount.times(fx))
            case .tax:
                taxTxnAmount = taxTxnAmount.plus(amount)
                taxTxnAmountC = taxTxnAmountC.plus(rawAmount.times(fx))
            case .dividend:
                if incomeRole == PortfolioCore.includedInUnitsRole {
                    totalInKindIncome = totalInKindIncome.plus(amount)
                    totalInKindIncomeC = totalInKindIncomeC.plus(rawAmount.times(fx))
                } else {
                    totalDividends = totalDividends.plus(amount)
                    totalDividendsC = totalDividendsC.plus(rawAmount.times(fx))
                }
            case .interest:
                totalInterestPaid = totalInterestPaid.plus(amount)
                totalInterestPaidC = totalInterestPaidC.plus(rawAmount.times(fx))
            case .rentIncome:
                totalRent = totalRent.plus(amount)
                totalRentC = totalRentC.plus(rawAmount.times(fx))
            case .appreciation:
                totalAppreciation = totalAppreciation.plus(amount)
            case .returnOfCapital:
                totalReturnOfCapital = totalReturnOfCapital.plus(amount)
                totalReturnOfCapitalC = totalReturnOfCapitalC.plus(rawAmount.times(fx))
            default:
                break
            }
        }

        let totalFees = feeTxnAmount.plus(feesFieldAmount)
        let totalTaxes = taxTxnAmount.plus(taxesFieldAmount)
        let totalFeesC = feeTxnAmountC.plus(feesFieldAmountC)
        let totalTaxesC = taxTxnAmountC.plus(taxesFieldAmountC)

        var totalUnits = ZERO
        var avgCostBasis = ZERO
        var totalBuyCost = ZERO
        var totalSellProceeds = ZERO
        var realizedGain = ZERO
        var unrealizedGain = ZERO
        var currentValue = ZERO
        var totalInvested = ZERO
        var accruedInterest = ZERO
        var projectedInterest = ZERO

        var avgCostBasisC = ZERO
        var totalBuyCostC = ZERO
        var totalSellProceedsC = ZERO
        var realizedGainC = ZERO
        var totalInvestedC = ZERO
        var oversold = false

        if isUnitBased {
            let cb = try calculateCostBasisByMethod(txns, method, opts: BasisOptions(defaultFxMultiplier: .decimal(mNow)))
            oversold = cb.oversold
            totalUnits = cb.unitsDecimal
            avgCostBasis = cb.avgCostBasisDecimal
            totalBuyCost = cb.totalBuyCostDecimal
            totalSellProceeds = cb.totalSellProceedsDecimal
            totalInvested = cb.totalCostDecimal
            realizedGain = cb.realizedGainDecimal

            avgCostBasisC = cb.avgCostBasisConvDecimal
            totalBuyCostC = cb.totalBuyCostConvDecimal
            totalSellProceedsC = cb.totalSellProceedsConvDecimal
            totalInvestedC = cb.totalCostConvDecimal
            realizedGainC = cb.realizedGainConvDecimal

            let currentPrice = inv.currentPrice.decimal
            currentValue = totalUnits.times(currentPrice)
            unrealizedGain = totalUnits.gt(ZERO)
                ? currentPrice.minus(avgCostBasis).times(totalUnits) : ZERO
        } else if isFixedIncome {
            totalInvested = totalBuyOrGiftAmount.minus(totalSellAmount).minus(totalReturnOfCapital)
            totalBuyCost = totalBuyOrGiftAmount
            totalSellProceeds = totalSellAmount
            totalInvestedC = totalBuyOrGiftAmountC.minus(totalSellAmountC).minus(totalReturnOfCapitalC)
            totalBuyCostC = totalBuyOrGiftAmountC
            totalSellProceedsC = totalSellAmountC

            let parsedInterestRate = jsToNumber(inv.interestRate)
            let interestRate = isNonZeroNumber(parsedInterestRate) ? parsedInterestRate : 0
            accruedInterest = toDecimal(calculateAccruedInterest(txns, jsNumber(totalInvested), .number(interestRate), todayYmd))
            projectedInterest = toDecimal(projectedAnnualInterest(jsNumber(totalInvested), .number(interestRate)))
            currentValue = totalInvested.plus(accruedInterest)
            realizedGain = ZERO
            unrealizedGain = accruedInterest
        } else if isRealEstate {
            totalInvested = totalBuyAmount.minus(totalSellAmount).minus(totalReturnOfCapital)
            totalBuyCost = totalBuyAmount
            totalSellProceeds = totalSellAmount
            totalInvestedC = totalBuyAmountC.minus(totalSellAmountC).minus(totalReturnOfCapitalC)
            totalBuyCostC = totalBuyAmountC
            totalSellProceedsC = totalSellAmountC
            currentValue = totalInvested.plus(totalAppreciation)
            unrealizedGain = totalAppreciation
            realizedGain = ZERO
        } else {
            totalInvested = totalBuyAmount.minus(totalSellAmount).minus(totalReturnOfCapital)
            totalBuyCost = totalBuyAmount
            totalSellProceeds = totalSellAmount
            totalInvestedC = totalBuyAmountC.minus(totalSellAmountC).minus(totalReturnOfCapitalC)
            totalBuyCostC = totalBuyAmountC
            totalSellProceedsC = totalSellAmountC
            currentValue = totalInvested
        }

        let totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent)
        let totalGain = realizedGain.plus(unrealizedGain)
        let gainLoss = isUnitBased
            ? totalGain.plus(totalIncome).minus(feeTxnAmount).minus(taxTxnAmount).minus(nonBasisExpenses)
            : totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes)
        let gainLossPercent = totalBuyCost.gt(ZERO)
            ? div(gainLoss, totalBuyCost).times(DecimalJS(100)) : ZERO
        let clampedInvested = totalInvested.gt(ZERO) ? totalInvested : ZERO

        let currentValueC = currentValue.times(mNow)
        let totalIncomeC = totalDividendsC.plus(totalInterestPaidC).plus(totalRentC)
        let unrealizedGainC = currentValueC.minus(totalInvestedC)
        let totalGainC = realizedGainC.plus(unrealizedGainC)
        let gainLossC = isUnitBased
            ? totalGainC.plus(totalIncomeC).minus(feeTxnAmountC).minus(taxTxnAmountC).minus(nonBasisExpensesC)
            : totalGainC.plus(totalIncomeC).minus(totalFeesC).minus(totalTaxesC)
        let assetGainC = gainLoss.times(mNow)
        let fxGainC = gainLossC.minus(assetGainC)
        let gainLossPercentC = totalBuyCostC.gt(ZERO)
            ? div(gainLossC, totalBuyCostC).times(DecimalJS(100)) : ZERO
        let clampedInvestedC = totalInvestedC.gt(ZERO) ? totalInvestedC : ZERO

        var core = SummaryCore()
        core.totalUnits = totalUnits
        core.avgCostBasis = avgCostBasis
        core.totalInvested = clampedInvested
        core.totalBuyCost = totalBuyCost
        core.totalSellProceeds = totalSellProceeds
        core.currentValue = currentValue
        core.realizedGain = realizedGain
        core.unrealizedGain = unrealizedGain
        core.totalGain = totalGain
        core.gainLoss = gainLoss
        core.gainLossPercent = gainLossPercent
        core.totalFees = totalFees
        core.totalTaxes = totalTaxes
        core.feeTxnAmount = feeTxnAmount
        core.taxTxnAmount = taxTxnAmount
        core.totalDividends = totalDividends
        core.totalInKindIncome = totalInKindIncome
        core.totalInterestPaid = totalInterestPaid
        core.totalRent = totalRent
        core.totalAppreciation = totalAppreciation
        core.totalIncome = totalIncome
        core.accruedInterest = accruedInterest
        core.projectedAnnualInterest = projectedInterest
        core.oversold = oversold
        core.converted.currentValue = currentValueC
        core.converted.totalInvested = clampedInvestedC
        core.converted.totalBuyCost = totalBuyCostC
        core.converted.totalSellProceeds = totalSellProceedsC
        core.converted.avgCostBasis = avgCostBasisC
        core.converted.realizedGain = realizedGainC
        core.converted.unrealizedGain = unrealizedGainC
        core.converted.totalGain = totalGainC
        core.converted.gainLoss = gainLossC
        core.converted.gainLossPercent = gainLossPercentC
        core.converted.assetGain = assetGainC
        core.converted.fxGain = fxGainC
        core.converted.totalFees = totalFeesC
        core.converted.totalTaxes = totalTaxesC
        core.converted.totalDividends = totalDividendsC
        core.converted.totalInKindIncome = totalInKindIncomeC
        core.converted.totalIncome = totalIncomeC
        return core
    }

}

extension String {
    /// `localeCompare` as the UTF-16 code-unit comparison of the corpus's dates.
    func utf16Compare(_ other: String) -> Int {
        let left = utf16
        let right = other.utf16
        for (a, b) in zip(left, right) {
            if a != b { return a < b ? -1 : 1 }
        }
        return left.count == right.count ? 0 : (left.count < right.count ? -1 : 1)
    }
}

private extension Calendar {
    static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }()
}
