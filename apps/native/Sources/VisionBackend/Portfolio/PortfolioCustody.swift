import Foundation

/// The ADR-108 partition surfaces of `packages/shared-utils/src/portfolio.ts`
/// and the custody projection of `portfolioCustody.ts`: per-(investment,
/// account) streams the same lot engines replay, the aggregation of the
/// partition cores, and the transfer/adjustment legs a custody move projects.
///
/// JS `Map` iterates in key-insertion order, so `Streams` keeps an ordered key
/// list beside the rows; the sorts add the original index because JS `sort` is
/// stable.
enum PortfolioCustody {
    static let custodyEventTypes: Set<String> = ["asset_transfer", "asset_adjustment"]

    /// The dispatch enums the shared core defines (see `PortfolioCore`).
    typealias CostMethod = PortfolioCore.CostMethod
    typealias AdjustmentKind = PortfolioCore.AdjustmentKind
    typealias BasisPolicy = PortfolioCore.BasisPolicy

    /// A partition: (account id or null) → rows, in first-touch order.
    struct Streams {
        private(set) var keys: [Double?] = []
        private var buckets: [Double: [PortfolioCore.Txn]] = [:]
        private var nullBucket: [PortfolioCore.Txn] = []

        mutating func push(_ key: Double?, _ row: PortfolioCore.Txn) {
            if let key {
                if buckets[key] == nil { keys.append(key) }
                buckets[key, default: []].append(row)
            } else {
                if !keys.contains(nil) { keys.append(nil) }
                nullBucket.append(row)
            }
        }

        func rows(of key: Double?) -> [PortfolioCore.Txn] {
            if let key { return buckets[key] ?? [] }
            return nullBucket
        }

        var count: Int { keys.count }

        /// The streams in insertion order, as `[...map.entries()]` yields them.
        var entries: [(key: Double?, rows: [PortfolioCore.Txn])] {
            keys.map { ($0, rows(of: $0)) }
        }
    }

    /// `partitionTxnsByAccount`: the per-account streams of one investment's
    /// transactions, with splits and return-of-capital allocations rewritten.
    static func partitionTxnsByAccount(
        _ txns: [PortfolioCore.Txn], method: String = "weighted_avg",
        opts: PortfolioCore.BasisOptions = PortfolioCore.BasisOptions()
    ) throws -> Streams {
        if txns.contains(where: { custodyEventTypes.contains($0.type) }) {
            return try projectAssetTransferPartitions(txns, method: method, opts: opts)
        }
        let ZERO = DecimalJS.zero
        let sorted = PortfolioCore.stableDateIdSort(txns)
        var partitions = Streams()
        var heldKeys: [Double?] = []
        var held: [Double: DecimalJS] = [:]
        var heldNull = ZERO

        func heldAt(_ key: Double?) -> DecimalJS {
            if let key { return held[key] ?? ZERO }
            return heldNull
        }
        func setHeld(_ key: Double?, _ value: DecimalJS) {
            if let key {
                if held[key] == nil { heldKeys.append(key) }
                held[key] = value
            } else {
                if !heldKeys.contains(nil) { heldKeys.append(nil) }
                heldNull = value
            }
        }
        func heldEntries() -> [(key: Double?, units: DecimalJS)] {
            heldKeys.map { ($0, heldAt($0)) }
        }
        func totalHeld() -> DecimalJS { heldEntries().reduce(ZERO) { $0.plus($1.units) } }

        for txn in sorted {
            let key = PortfolioCore.partitionKey(of: txn)
            let units = txn.units.decimal

            switch txn.kind {
            case .buy, .gift:
                partitions.push(key, txn)
                setHeld(key, heldAt(key).plus(units))
            case .sell:
                partitions.push(key, txn)
                let before = heldAt(key)
                setHeld(key, before.minus(PortfolioCore.min(units, before)))
            case .split:
                let newGlobalUnits = units
                let before = totalHeld()
                if before.gt(ZERO), newGlobalUnits.gt(ZERO) {
                    let ratio = PortfolioCore.div(newGlobalUnits, before)
                    let holders = heldEntries().filter { $0.units.gt(ZERO) }
                    var allocated = ZERO
                    for (index, holder) in holders.enumerated() {
                        let partitionNewTotal = index == holders.count - 1
                            ? newGlobalUnits.minus(allocated)
                            : holder.units.times(ratio)
                        allocated = allocated.plus(partitionNewTotal)
                        setHeld(holder.key, partitionNewTotal)
                        var row = txn
                        row.units = .decimal(partitionNewTotal)
                        row.fees = .number(0)
                        row.taxes = .number(0)
                        partitions.push(holder.key, row)
                    }
                }
                if carriesFeesOrTaxes(txn) {
                    var row = txn
                    row.units = .number(0)
                    partitions.push(key, row)
                }
            case .returnOfCapital:
                let amount = txn.amount.decimal
                let unitsNow = totalHeld()
                if unitsNow.gt(ZERO), !amount.eq(ZERO) {
                    let holders = heldEntries().filter { $0.units.gt(ZERO) }
                    var allocated = ZERO
                    for (index, holder) in holders.enumerated() {
                        let share = index == holders.count - 1
                            ? amount.minus(allocated)
                            : PortfolioCore.div(amount.times(holder.units), unitsNow)
                        allocated = allocated.plus(share)
                        var row = txn
                        row.amount = .decimal(share)
                        row.fees = .number(0)
                        row.taxes = .number(0)
                        partitions.push(holder.key, row)
                    }
                }
                if carriesFeesOrTaxes(txn) {
                    var row = txn
                    row.amount = .number(0)
                    partitions.push(key, row)
                }
            default:
                partitions.push(key, txn)
            }
        }
        return partitions
    }

    /// The fee/tax-carrying residual of a rewritten corporate action.
    private static func carriesFeesOrTaxes(_ txn: PortfolioCore.Txn) -> Bool {
        !txn.fees.decimal.eq(DecimalJS.zero) || !txn.taxes.decimal.eq(DecimalJS.zero)
    }

    /// `acquisitionOrder` sorts a lot array stably (JS sort keeps ties).
    private static func sortedByAcquisition(_ lots: [PortfolioCore.CustodyLot]) -> [PortfolioCore.CustodyLot] {
        lots.enumerated().sorted { left, right in
            let byDate = left.element.acquiredDate.utf16Compare(right.element.acquiredDate)
            if byDate != 0 { return byDate < 0 }
            let byId = left.element.acquisitionId - right.element.acquisitionId
            if byId != 0 { return byId < 0 }
            return left.offset < right.offset
        }.map(\.element)
    }

    /// `projectAssetTransferPartitions` (`portfolioCustody.ts`): custody moves
    /// are replay events; the temporary legs carry the remaining lots.
    static func projectAssetTransferPartitions(
        _ txns: [PortfolioCore.Txn], method: String = "weighted_avg",
        opts: PortfolioCore.BasisOptions = PortfolioCore.BasisOptions()
    ) throws -> Streams {
        let ZERO = DecimalJS.zero
        var partitions = Streams()
        // The custody map keys on `account_id ?? null`, so the null bucket lives
        // beside the numbered ones (TS `Map<PartitionKey, CustodyLot[]>`).
        var custodyKeys: [Double?] = []
        var custody: [Double: [PortfolioCore.CustodyLot]] = [:]
        var custodyNull: [PortfolioCore.CustodyLot] = []

        func register(_ key: Double?) {
            if !custodyKeys.contains(where: { $0 == key }) { custodyKeys.append(key) }
        }
        func lotsAt(_ key: Double?) -> [PortfolioCore.CustodyLot] {
            guard let key else {
                register(nil)
                return custodyNull
            }
            register(key)
            return custody[key] ?? []
        }
        func setLots(_ key: Double?, _ lots: [PortfolioCore.CustodyLot]) {
            guard let key else {
                register(nil)
                custodyNull = lots
                return
            }
            register(key)
            custody[key] = lots
        }
        func held(_ lots: [PortfolioCore.CustodyLot]) -> DecimalJS {
            lots.reduce(ZERO) { $0.plus($1.units) }
        }
        /// The eligible lots of `lots`, as indices the caller can mutate through.
        func eligibleIndices(_ lots: [PortfolioCore.CustodyLot], _ predicate: (PortfolioCore.CustodyLot) -> Bool) -> [Int] {
            lots.indices.filter { predicate(lots[$0]) }
        }
        /// JS's lot object sharing: the filtered lots and `lots` are the same
        /// objects, so a part taken subtracts through its index.
        func consume(
            _ key: Double?, _ requested: DecimalJS,
            _ predicate: (PortfolioCore.CustodyLot) -> Bool = { _ in true }
        ) -> [PortfolioCore.CustodyLot] {
            var lots = lotsAt(key)
            let eligible = eligibleIndices(lots, predicate)
            let total = eligible.reduce(ZERO) { $0.plus(lots[$1].units) }
            var taken: [PortfolioCore.CustodyLot] = []
            var remaining = PortfolioCore.min(requested, total)
            if CostMethod(rawValue: method) == .weightedAvg {
                let ratio = total.gt(ZERO) ? PortfolioCore.div(remaining, total) : ZERO
                for (position, index) in eligible.enumerated() {
                    let lot = lots[index]
                    let units = position == eligible.count - 1
                        ? remaining
                        : PortfolioCore.min(remaining, lot.units.times(ratio))
                    let lotRatio = lot.units.gt(ZERO) ? PortfolioCore.div(units, lot.units) : ZERO
                    var part = lot
                    part.units = units
                    part.costBasis = lot.costBasis.times(lotRatio)
                    part.costBasisConv = lot.costBasisConv.times(lotRatio)
                    if part.units.gt(ZERO) { taken.append(part) }
                    lots[index].units = lot.units.minus(part.units)
                    lots[index].costBasis = lot.costBasis.minus(part.costBasis)
                    lots[index].costBasisConv = lot.costBasisConv.minus(part.costBasisConv)
                    remaining = remaining.minus(units)
                }
            } else {
                let order = CostMethod(rawValue: method) == .lifo ? eligible.reversed() : eligible
                for index in order {
                    let lot = lots[index]
                    if remaining.lte(ZERO) { continue }
                    if lot.units.lte(ZERO) { continue }
                    let units = PortfolioCore.min(remaining, lot.units)
                    let ratio = PortfolioCore.div(units, lot.units)
                    var part = lot
                    part.units = units
                    part.costBasis = lot.costBasis.times(ratio)
                    part.costBasisConv = lot.costBasisConv.times(ratio)
                    taken.append(part)
                    lots[index].units = lot.units.minus(part.units)
                    lots[index].costBasis = lot.costBasis.minus(part.costBasis)
                    lots[index].costBasisConv = lot.costBasisConv.minus(part.costBasisConv)
                    remaining = remaining.minus(units)
                }
            }
            setLots(key, lots.filter { $0.units.gt(ZERO) })
            return taken
        }

        for row in PortfolioCore.stableDateIdSort(txns) {
            let key = PortfolioCore.partitionKey(of: row)
            let units = row.units.decimal
            switch row.kind {
            case .buy, .gift:
                let cost = row.amount.decimal.plus(row.fees.decimal).plus(row.taxes.decimal)
                let nativeFx = PortfolioCore.fxDecimal(row.nativeFxMultiplier)
                let convFx = (row.fxMultiplier ?? opts.defaultFxMultiplier ?? .number(1)).decimal
                let lot = PortfolioCore.CustodyLot(
                    acquisitionType: row.type, sourceRecordHash: row.sourceRecordHash,
                    units: units, costBasis: cost.times(nativeFx),
                    costBasisConv: cost.times(convFx),
                    acquiredDate: row.date, acquisitionId: PortfolioCore.number(row.id),
                    currency: row.nativeCurrency ?? row.currency,
                    fxResolved: row.currency == PortfolioCore.euroCurrency
                        || (row.fxMultiplier?.decimal.gt(ZERO) ?? false))
                var lots = lotsAt(key)
                lots.append(lot)
                setLots(key, sortedByAcquisition(lots))
                partitions.push(key, row)
            case .sell:
                _ = consume(key, units)
                partitions.push(key, row)
            case .assetAdjustment:
                guard let keyInteger = key, keyInteger.rounded() == keyInteger, keyInteger > 0, units.gt(ZERO) else {
                    throw PortfolioCore.Failure(message: "Asset adjustment requires an account and positive units")
                }
                let keyId = keyInteger
                let reversal = AdjustmentKind(rawValue: row.adjustmentKind ?? "") == .yieldReversal
                if reversal && BasisPolicy(rawValue: row.basisPolicy ?? "") != .zeroYieldOnly
                    || !reversal && (AdjustmentKind(rawValue: row.adjustmentKind ?? "") != .assetFee || BasisPolicy(rawValue: row.basisPolicy ?? "") != .carried) {
                    throw PortfolioCore.Failure(message: "Asset adjustment basis policy is unresolved")
                }
                let eligibleHashes = Set(row.eligibleSourceRecordHashes)
                let eligibleLot: (PortfolioCore.CustodyLot) -> Bool = { lot in
                    !reversal
                        || (lot.acquisitionType == PortfolioCore.TxnKind.gift.rawValue
                            && lot.costBasis.eq(ZERO)
                            && lot.costBasisConv.eq(ZERO)
                            && lot.sourceRecordHash.map { eligibleHashes.contains($0) } ?? false)
                }
                if units.gt(held(lotsAt(keyId).filter(eligibleLot))) {
                    throw PortfolioCore.Failure(
                        message: reversal
                            ? "Yield reversal exceeds source-proven zero-basis yield holdings"
                            : "Asset fee exceeds source holdings")
                }
                let removed = consume(keyId, units, eligibleLot)
                let basis = removed.reduce(ZERO) { $0.plus($1.costBasis) }
                let basisConv = removed.reduce(ZERO) { $0.plus($1.costBasisConv) }
                var leg = row
                leg.type = reversal ? "unit_reversal" : "asset_fee"
                leg.amount = .number(0)
                leg.fees = .number(0)
                leg.taxes = .number(0)
                leg.transferredBasis = basis
                leg.transferredBasisConv = basisConv
                leg.assetFeeBasis = reversal ? ZERO : basis
                leg.assetFeeBasisConv = reversal ? ZERO : basisConv
                leg.consumedLots = removed
                partitions.push(keyId, leg)
            case .assetTransfer:
                let source = row.sourceAccountId
                let destination = row.destinationAccountId
                guard let sourceId = source, sourceId.rounded() == sourceId, sourceId > 0,
                    let destinationId = destination, destinationId.rounded() == destinationId,
                    destinationId > 0, sourceId != destinationId, units.gt(ZERO)
                else {
                    throw PortfolioCore.Failure(
                        message: "Asset transfer requires distinct accounts and positive units")
                }
                let feeUnits = row.feeUnits.decimal
                if feeUnits.lt(ZERO) || feeUnits.gte(units) {
                    throw PortfolioCore.Failure(message: "Asset transfer fee units are invalid")
                }
                if units.gt(held(lotsAt(sourceId))) {
                    throw PortfolioCore.Failure(message: "Asset transfer exceeds source holdings")
                }
                let moved = consume(sourceId, units)
                let transferredBasis = moved.reduce(ZERO) { $0.plus($1.costBasis) }
                let transferredBasisConv = moved.reduce(ZERO) { $0.plus($1.costBasisConv) }
                let receivedUnits = units.minus(feeUnits)
                let ratio = PortfolioCore.div(receivedUnits, units)
                let received = moved.map { lot in
                    var receivedLot = lot
                    receivedLot.units = lot.units.times(ratio)
                    receivedLot.costBasis = lot.costBasis.times(ratio)
                    receivedLot.costBasisConv = lot.costBasisConv.times(ratio)
                    return receivedLot
                }
                let feeRatio = PortfolioCore.div(feeUnits, units)
                let receivedBasis = transferredBasis.times(ratio)
                let receivedBasisConv = transferredBasisConv.times(ratio)
                var leg = row
                leg.amount = .number(0)
                leg.fees = .number(0)
                leg.taxes = .number(0)
                leg.transferredBasis = transferredBasis
                leg.transferredBasisConv = transferredBasisConv
                leg.transferredLots = received
                var outLeg = leg
                outLeg.type = "transfer_out"
                outLeg.accountId = sourceId
                outLeg.assetFeeBasis = transferredBasis.minus(receivedBasis)
                outLeg.assetFeeBasisConv = transferredBasisConv.minus(receivedBasisConv)
                partitions.push(sourceId, outLeg)
                var inLeg = leg
                inLeg.type = "transfer_in"
                inLeg.accountId = destinationId
                inLeg.units = .decimal(receivedUnits)
                inLeg.transferredBasis = receivedBasis
                inLeg.transferredBasisConv = receivedBasisConv
                partitions.push(destinationId, inLeg)
                var lots = lotsAt(destinationId)
                lots.append(contentsOf: received)
                setLots(destinationId, sortedByAcquisition(lots))
            case .split:
                let total = custodyKeys.reduce(ZERO) { sum, key in sum.plus(held(lotsAt(key))) }
                if total.gt(ZERO), units.gt(ZERO) {
                    let ratio = PortfolioCore.div(units, total)
                    for account in custodyKeys {
                        var lots = lotsAt(account)
                        let local = held(lots)
                        if local.lte(ZERO) { continue }
                        for index in lots.indices { lots[index].units = lots[index].units.times(ratio) }
                        setLots(account, lots)
                        var splitRow = row
                        splitRow.units = .decimal(local.times(ratio))
                        splitRow.fees = .number(0)
                        splitRow.taxes = .number(0)
                        partitions.push(account, splitRow)
                    }
                }
                if carriesFeesOrTaxes(row) {
                    var residual = row
                    residual.units = .number(0)
                    partitions.push(key, residual)
                }
            case .returnOfCapital:
                let total = custodyKeys.reduce(ZERO) { sum, key in sum.plus(held(lotsAt(key))) }
                let perUnit = total.gt(ZERO) ? PortfolioCore.div(row.amount.decimal, total) : ZERO
                let perUnitNative = perUnit.times(PortfolioCore.fxDecimal(row.nativeFxMultiplier))
                for account in custodyKeys {
                    var lots = lotsAt(account)
                    let local = held(lots)
                    if local.lte(ZERO) { continue }
                    let basis = lots.reduce(ZERO) { $0.plus($1.costBasis) }
                    let weightedFactor = basis.gt(ZERO)
                        ? PortfolioCore.div(
                            DecimalJS.max(ZERO, basis.minus(perUnitNative.times(local))), basis) : ZERO
                    for index in lots.indices {
                        if CostMethod(rawValue: method) == .weightedAvg {
                            let factor = weightedFactor
                            lots[index].costBasis = lots[index].costBasis.times(factor)
                            lots[index].costBasisConv = lots[index].costBasisConv.times(factor)
                            continue
                        }
                        let reducedPlus = DecimalJS.max(
                            ZERO, lots[index].costBasis.minus(perUnitNative.times(lots[index].units)))
                        let factor = lots[index].costBasis.gt(ZERO)
                            ? PortfolioCore.div(reducedPlus, lots[index].costBasis) : ZERO
                        lots[index].costBasisConv = lots[index].costBasisConv.times(factor)
                        lots[index].costBasis = reducedPlus
                    }
                    setLots(account, lots)
                    var rocRow = row
                    rocRow.amount = .decimal(perUnit.times(local))
                    rocRow.fees = .number(0)
                    rocRow.taxes = .number(0)
                    partitions.push(account, rocRow)
                }
                if carriesFeesOrTaxes(row) {
                    var residual = row
                    residual.amount = .number(0)
                    partitions.push(key, residual)
                }
            default:
                partitions.push(key, row)
            }
        }
        return partitions
    }
}

extension PortfolioCore {
    /// `InvestmentSummaryPartition` / `PartitionedInvestmentSummaryCore`.
    struct Partition: Sendable {
        var accountId: Double?
        var contributionKind: String
        var core: SummaryCore
    }

    struct PartitionedCore: Sendable {
        var core: SummaryCore
        var partitions: [Partition]
        var fullyAssigned: Bool
    }

    static func partitionKey(of txn: Txn) -> Double? { txn.accountId }

    /// `areLotsFullyAssigned`.
    static func areLotsFullyAssigned(_ txns: [Txn]) -> Bool {
        txns.allSatisfy { !lotTxnTypes.contains($0.type) || $0.accountId != nil }
    }

    /// `contributionKindOf`.
    static func contributionKindOf(_ rows: [Txn]) -> String {
        rows.contains { lotTxnTypes.contains($0.type) } ? "position" : "non_position"
    }

    /// `buildInvestmentSummaryCorePartitioned`: the partition-aware core.
    static func buildInvestmentSummaryCorePartitioned(
        _ inv: Investment, _ txns: [Txn], opts: Options
    ) throws -> PartitionedCore {
        let isUnitBased = unitBasedClasses.contains(inv.assetClass)

        if !isUnitBased {
            let core = try buildInvestmentSummaryCore(inv, txns, opts: opts)
            var accountKeys: [Double?] = []
            for txn in txns {
                if !accountKeys.contains(where: { $0 == txn.accountId }) {
                    accountKeys.append(txn.accountId)
                }
            }
            let fullyAssigned = txns.isEmpty
                || (accountKeys.count == 1 && accountKeys[0] != nil)
            let singleKey = accountKeys.first.flatMap { $0 }
            return PartitionedCore(
                core: core,
                partitions: !txns.isEmpty
                    ? [Partition(
                        accountId: !txns.isEmpty && fullyAssigned ? singleKey : nil,
                        contributionKind: contributionKindOf(txns), core: core)]
                    : [],
                fullyAssigned: fullyAssigned)
        }

        let fullyAssigned = areLotsFullyAssigned(txns)
        if !fullyAssigned {
            if txns.contains(where: { PortfolioCustody.custodyEventTypes.contains($0.type) }) {
                throw Failure(message: "Asset custody acquisitions are not fully assigned")
            }
            let core = try buildInvestmentSummaryCore(inv, txns, opts: opts)
            return PartitionedCore(
                core: core,
                partitions: !txns.isEmpty
                    ? [Partition(accountId: nil, contributionKind: "position", core: core)]
                    : [],
                fullyAssigned: false)
        }

        let streams = try PortfolioCustody.partitionTxnsByAccount(
            txns, method: opts.costBasisMethod,
            opts: BasisOptions(defaultFxMultiplier: opts.fxMultiplierNow))
        if streams.count <= 1 {
            let first = streams.entries.first
            let projectedRows: [Txn]
            if streams.count == 1, txns.contains(where: { $0.kind == .assetAdjustment }) {
                projectedRows = first?.rows ?? []
            } else {
                projectedRows = txns
            }
            let core = try buildInvestmentSummaryCore(inv, projectedRows, opts: opts)
            return PartitionedCore(
                core: core,
                partitions: streams.count == 1
                    ? [Partition(
                        accountId: first?.key,
                        contributionKind: contributionKindOf(first?.rows ?? []), core: core)]
                    : [],
                fullyAssigned: true)
        }

        var partitions: [Partition] = []
        for entry in streams.entries {
            partitions.append(Partition(
                accountId: entry.key,
                contributionKind: contributionKindOf(entry.rows),
                core: try buildInvestmentSummaryCore(inv, entry.rows, opts: opts)))
        }
        return PartitionedCore(
            core: aggregatePartitionCores(partitions.map(\.core)),
            partitions: partitions,
            fullyAssigned: true)
    }

    /// `aggregatePartitionCores`: additive fields sum, the ratios re-derive.
    static func aggregatePartitionCores(_ cores: [SummaryCore]) -> SummaryCore {
        let ZERO = DecimalJS.zero
        func sum(_ pick: (SummaryCore) -> DecimalJS) -> DecimalJS {
            cores.reduce(ZERO) { $0.plus(pick($1)) }
        }
        var agg = SummaryCore()
        agg.totalUnits = sum { $0.totalUnits }
        agg.totalInvested = sum { $0.totalInvested }
        agg.totalBuyCost = sum { $0.totalBuyCost }
        agg.totalSellProceeds = sum { $0.totalSellProceeds }
        agg.currentValue = sum { $0.currentValue }
        agg.realizedGain = sum { $0.realizedGain }
        agg.unrealizedGain = sum { $0.unrealizedGain }
        agg.totalGain = sum { $0.totalGain }
        agg.gainLoss = sum { $0.gainLoss }
        agg.totalFees = sum { $0.totalFees }
        agg.totalTaxes = sum { $0.totalTaxes }
        agg.feeTxnAmount = sum { $0.feeTxnAmount }
        agg.taxTxnAmount = sum { $0.taxTxnAmount }
        agg.totalDividends = sum { $0.totalDividends }
        agg.totalInKindIncome = sum { $0.totalInKindIncome }
        agg.totalInterestPaid = sum { $0.totalInterestPaid }
        agg.totalRent = sum { $0.totalRent }
        agg.totalAppreciation = sum { $0.totalAppreciation }
        agg.totalIncome = sum { $0.totalIncome }
        agg.accruedInterest = sum { $0.accruedInterest }
        agg.projectedAnnualInterest = sum { $0.projectedAnnualInterest }
        agg.avgCostBasis = agg.totalUnits.gt(ZERO)
            ? div(agg.totalInvested, agg.totalUnits) : ZERO
        agg.gainLossPercent = agg.totalBuyCost.gt(ZERO)
            ? div(agg.gainLoss, agg.totalBuyCost).times(DecimalJS(100)) : ZERO
        agg.converted.currentValue = sum { $0.converted.currentValue }
        agg.converted.totalInvested = sum { $0.converted.totalInvested }
        agg.converted.totalBuyCost = sum { $0.converted.totalBuyCost }
        agg.converted.totalSellProceeds = sum { $0.converted.totalSellProceeds }
        agg.converted.realizedGain = sum { $0.converted.realizedGain }
        agg.converted.unrealizedGain = sum { $0.converted.unrealizedGain }
        agg.converted.totalGain = sum { $0.converted.totalGain }
        agg.converted.gainLoss = sum { $0.converted.gainLoss }
        agg.converted.assetGain = sum { $0.converted.assetGain }
        agg.converted.fxGain = sum { $0.converted.fxGain }
        agg.converted.totalFees = sum { $0.converted.totalFees }
        agg.converted.totalTaxes = sum { $0.converted.totalTaxes }
        agg.converted.totalDividends = sum { $0.converted.totalDividends }
        agg.converted.totalInKindIncome = sum { $0.converted.totalInKindIncome }
        agg.converted.totalIncome = sum { $0.converted.totalIncome }
        agg.converted.avgCostBasis = agg.totalUnits.gt(ZERO)
            ? div(agg.converted.totalInvested, agg.totalUnits) : ZERO
        agg.converted.gainLossPercent = agg.converted.totalBuyCost.gt(ZERO)
            ? div(agg.converted.gainLoss, agg.converted.totalBuyCost).times(DecimalJS(100)) : ZERO
        agg.oversold = cores.contains { $0.oversold }
        return agg
    }

    /// `partitionOversellDeficits`: excess units requested per account.
    static func partitionOversellDeficits(_ txns: [Txn]) throws -> [Double: Double] {
        guard areLotsFullyAssigned(txns) else { return [:] }
        var deficits: [Double: Double] = [:]
        let streams = try PortfolioCustody.partitionTxnsByAccount(txns)
        for entry in streams.entries {
            guard let accountId = entry.key else { continue }
            var heldUnits = DecimalJS.zero
            var deficit = DecimalJS.zero
            for row in entry.rows {
                let units = row.units.decimal
                switch row.kind {
                case .buy, .gift, .transferIn:
                    heldUnits = heldUnits.plus(units)
                case .transferOut, .assetFee, .unitReversal:
                    heldUnits = DecimalJS.max(DecimalJS.zero, heldUnits.minus(units))
                case .sell:
                    if units.gt(heldUnits) { deficit = deficit.plus(units.minus(heldUnits)) }
                    heldUnits = DecimalJS.max(DecimalJS.zero, heldUnits.minus(units))
                case .split:
                    if heldUnits.gt(DecimalJS.zero), units.gt(DecimalJS.zero) { heldUnits = units }
                default:
                    break
                }
            }
            if deficit.gt(DecimalJS.zero) { deficits[accountId] = jsNumber(deficit) }
        }
        return deficits
    }
}
