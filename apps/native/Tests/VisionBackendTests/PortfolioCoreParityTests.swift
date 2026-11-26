import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Replays `parity/plans/portfolio-core.jsonl`: calls of the shared portfolio summary core
/// (packages/shared-utils/src/portfolio.ts) — day counts, the weighted-average, FIFO and LIFO
/// cost-basis engines, fixed-income accrued and projected interest, the per-investment
/// summary core with its converted FX track, ADR-108 account partitions, custody transfers
/// and adjustments, the partitioned summary core and account-local oversell deficits — over
/// generated transaction streams, with what Bun answered (`bun run native:parity-plans`).
/// Decimal fields travel as decimal text; object shape (not key order) is compared.
@Suite struct PortfolioCoreParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("portfolio-core.jsonl")

    private struct UnknownOperation: Error { let name: String }

    // MARK: input decoding

    private static func numeric(_ value: JSValue?) -> PortfolioCore.Numeric {
        switch value {
        case .number(let number): return .number(number)
        case .string(let text): return .text(text)
        default: return .null
        }
    }

    private static func numericPresent(_ value: JSValue?) -> PortfolioCore.Numeric? {
        guard let value, value != .null else { return nil }
        return numeric(value)
    }

    private static func wireDecimal(_ value: JSValue?) -> DecimalJS? {
        guard let value, value != .null else { return nil }
        return (try? DecimalJS(value.stringValue ?? value.javaScriptString)) ?? .zero
    }

    private static func hashes(_ value: JSValue?) -> [String?] {
        guard case .array(let items)? = value else { return [] }
        return items.map { $0 == .null ? nil : $0.stringValue }
    }

    private static func lot(_ value: JSValue) -> PortfolioCore.CustodyLot {
        let wire = value.objectValue ?? JSObject()
        return PortfolioCore.CustodyLot(
            acquisitionType: wire["acquisitionType"]?.stringValue,
            sourceRecordHash: wire["sourceRecordHash"]?.stringValue,
            units: wireDecimal(wire["units"]) ?? .zero,
            costBasis: wireDecimal(wire["costBasis"]) ?? .zero,
            costBasisConv: wireDecimal(wire["costBasisConv"]) ?? .zero,
            acquiredDate: wire["acquiredDate"]?.stringValue ?? "",
            acquisitionId: wire["acquisitionId"]?.javaScriptNumber ?? 0,
            currency: wire["currency"]?.stringValue,
            fxResolved: wire["fxResolved"] == .bool(true))
    }

    private static func lots(_ value: JSValue?) -> [PortfolioCore.CustodyLot] {
        guard case .array(let items)? = value else { return [] }
        return items.map(lot)
    }

    private static func txn(_ value: JSValue) -> PortfolioCore.Txn {
        let wire = value.objectValue ?? JSObject()
        func field(_ key: String) -> JSValue? {
            guard let value = wire[key], value != .null else { return nil }
            return value
        }
        var row = PortfolioCore.Txn(
            id: field("id").map(\.javaScriptNumber),
            type: wire["type"]?.stringValue ?? "",
            date: wire["date"]?.stringValue ?? "",
            fxMultiplier: numericPresent(wire["fxMultiplier"]),
            nativeFxMultiplier: numericPresent(wire["nativeFxMultiplier"]),
            nativeCurrency: field("nativeCurrency")?.stringValue,
            units: numeric(wire["units"]),
            amount: numeric(wire["amount"]),
            fees: numeric(wire["fees"]),
            taxes: numeric(wire["taxes"]),
            incomeRecognitionRole: field("income_recognition_role")?.stringValue,
            accountId: field("account_id").map(\.javaScriptNumber),
            sourceAccountId: field("source_account_id").map(\.javaScriptNumber),
            destinationAccountId: field("destination_account_id").map(\.javaScriptNumber),
            feeUnits: numeric(wire["fee_units"]),
            adjustmentKind: field("adjustment_kind")?.stringValue,
            basisPolicy: field("basis_policy")?.stringValue,
            eligibleSourceRecordHashes: hashes(wire["eligible_source_record_hashes"]),
            sourceRecordHash: field("source_record_hash")?.stringValue,
            currency: field("currency")?.stringValue)
        row.transferredBasis = wireDecimal(wire["transferredBasis"])
        row.transferredBasisConv = wireDecimal(wire["transferredBasisConv"])
        row.assetFeeBasis = wireDecimal(wire["assetFeeBasis"])
        row.assetFeeBasisConv = wireDecimal(wire["assetFeeBasisConv"])
        row.transferredLots = lots(wire["transferredLots"])
        row.consumedLots = lots(wire["consumedLots"])
        return row
    }

    private static func txns(_ value: JSValue?) -> [PortfolioCore.Txn] {
        guard case .array(let rows)? = value else { return [] }
        return rows.map(txn)
    }

    private static func investment(_ value: JSValue?) -> PortfolioCore.Investment {
        let wire = value?.objectValue ?? JSObject()
        return PortfolioCore.Investment(
            assetClass: wire["asset_class"]?.stringValue ?? "",
            currentPrice: numeric(wire["current_price"]),
            interestRate: numeric(wire["interest_rate"]))
    }

    private static func options(_ value: JSValue?) -> PortfolioCore.Options {
        let wire = value?.objectValue ?? JSObject()
        return PortfolioCore.Options(
            costBasisMethod: wire["costBasisMethod"]?.stringValue ?? "weighted_avg",
            todayYmd: wire["todayYmd"]?.stringValue ?? "",
            fxMultiplierNow: numericPresent(wire["fxMultiplierNow"]))
    }

    private static func basisOptions(_ value: JSValue?) -> PortfolioCore.BasisOptions {
        PortfolioCore.BasisOptions(defaultFxMultiplier: numericPresent(value))
    }

    // MARK: answer wiring

    private static func dec(_ value: DecimalJS) -> JSValue { .string(value.toFixed) }

    private static func decimalWire(_ value: DecimalJS?) -> JSValue {
        value.map { .string($0.toFixed) } ?? .null
    }

    private static func lotWire(_ lot: PortfolioCore.CustodyLot) -> JSValue {
        .object(JSObject([
            ("units", dec(lot.units)),
            ("costBasis", dec(lot.costBasis)),
            ("costBasisConv", dec(lot.costBasisConv)),
            ("acquiredDate", .string(lot.acquiredDate)),
            ("acquisitionId", .number(lot.acquisitionId)),
            ("acquisitionType", lot.acquisitionType.map(JSValue.string) ?? .null),
            ("sourceRecordHash", lot.sourceRecordHash.map(JSValue.string) ?? .null),
            ("currency", lot.currency.map(JSValue.string) ?? .null),
            ("fxResolved", .bool(lot.fxResolved)),
        ]))
    }

    private static func lotsWire(_ value: [PortfolioCore.CustodyLot]) -> JSValue {
        value.isEmpty ? .null : .array(value.map(lotWire))
    }

    private static func legWire(_ row: PortfolioCore.Txn) -> JSValue {
        .object(JSObject([
            ("type", .string(row.type)),
            ("date", .string(row.date)),
            ("id", row.id.map { .number($0) } ?? .null),
            ("accountId", row.accountId.map { .number($0) } ?? .null),
            ("units", dec(row.units.decimal)),
            ("amount", dec(row.amount.decimal)),
            ("fees", dec(row.fees.decimal)),
            ("taxes", dec(row.taxes.decimal)),
            ("transferredBasis", decimalWire(row.transferredBasis)),
            ("transferredBasisConv", decimalWire(row.transferredBasisConv)),
            ("assetFeeBasis", decimalWire(row.assetFeeBasis)),
            ("assetFeeBasisConv", decimalWire(row.assetFeeBasisConv)),
            ("transferredLots", lotsWire(row.transferredLots)),
            ("consumedLots", lotsWire(row.consumedLots)),
        ]))
    }

    private static func streamsWire(_ entries: [(key: Double?, rows: [PortfolioCore.Txn])]) -> JSValue {
        .array(entries.map { entry in
            .array([
                entry.key.map { .number($0) } ?? .null,
                .array(entry.rows.map(legWire)),
            ])
        })
    }

    private static func coreWire(_ core: PortfolioCore.SummaryCore) -> JSValue {
        .object(JSObject([
            ("totalUnits", dec(core.totalUnits)),
            ("avgCostBasis", dec(core.avgCostBasis)),
            ("totalInvested", dec(core.totalInvested)),
            ("totalBuyCost", dec(core.totalBuyCost)),
            ("totalSellProceeds", dec(core.totalSellProceeds)),
            ("currentValue", dec(core.currentValue)),
            ("realizedGain", dec(core.realizedGain)),
            ("unrealizedGain", dec(core.unrealizedGain)),
            ("totalGain", dec(core.totalGain)),
            ("gainLoss", dec(core.gainLoss)),
            ("gainLossPercent", dec(core.gainLossPercent)),
            ("totalFees", dec(core.totalFees)),
            ("totalTaxes", dec(core.totalTaxes)),
            ("feeTxnAmount", dec(core.feeTxnAmount)),
            ("taxTxnAmount", dec(core.taxTxnAmount)),
            ("totalDividends", dec(core.totalDividends)),
            ("totalInKindIncome", dec(core.totalInKindIncome)),
            ("totalInterestPaid", dec(core.totalInterestPaid)),
            ("totalRent", dec(core.totalRent)),
            ("totalAppreciation", dec(core.totalAppreciation)),
            ("totalIncome", dec(core.totalIncome)),
            ("accruedInterest", dec(core.accruedInterest)),
            ("projectedAnnualInterest", dec(core.projectedAnnualInterest)),
            ("oversold", .bool(core.oversold)),
            ("converted", .object(JSObject([
                ("currentValue", dec(core.converted.currentValue)),
                ("totalInvested", dec(core.converted.totalInvested)),
                ("totalBuyCost", dec(core.converted.totalBuyCost)),
                ("totalSellProceeds", dec(core.converted.totalSellProceeds)),
                ("avgCostBasis", dec(core.converted.avgCostBasis)),
                ("realizedGain", dec(core.converted.realizedGain)),
                ("unrealizedGain", dec(core.converted.unrealizedGain)),
                ("totalGain", dec(core.converted.totalGain)),
                ("gainLoss", dec(core.converted.gainLoss)),
                ("gainLossPercent", dec(core.converted.gainLossPercent)),
                ("assetGain", dec(core.converted.assetGain)),
                ("fxGain", dec(core.converted.fxGain)),
                ("totalFees", dec(core.converted.totalFees)),
                ("totalTaxes", dec(core.converted.totalTaxes)),
                ("totalDividends", dec(core.converted.totalDividends)),
                ("totalInKindIncome", dec(core.converted.totalInKindIncome)),
                ("totalIncome", dec(core.converted.totalIncome)),
            ]))),
        ]))
    }

    private static func costBasisWire(_ result: PortfolioCore.CostBasisResult) -> JSValue {
        .object(JSObject([
            ("totalUnits", .number(result.totalUnits)),
            ("totalCost", .number(result.totalCost)),
            ("avgCostBasis", .number(result.avgCostBasis)),
            ("realizedGain", .number(result.realizedGain)),
            ("totalBuyCost", .number(result.totalBuyCost)),
            ("totalSellProceeds", .number(result.totalSellProceeds)),
            ("totalCostConv", .number(result.totalCostConv)),
            ("avgCostBasisConv", .number(result.avgCostBasisConv)),
            ("realizedGainConv", .number(result.realizedGainConv)),
            ("totalBuyCostConv", .number(result.totalBuyCostConv)),
            ("totalSellProceedsConv", .number(result.totalSellProceedsConv)),
            ("_oversold", .bool(result.oversold)),
        ]))
    }

    /// `JSON.stringify` keeps NaN and the infinities as `null`.
    private static func number(_ value: Double) -> JSValue {
        value.isFinite ? .number(value) : .null
    }

    // MARK: the operations

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        let name = op.first?.stringValue ?? ""
        func arg(_ index: Int) -> JSValue? { op.count > index ? op[index] : nil }
        switch name {
        case "daysBetween":
            return number(PortfolioCore.daysBetweenYmd(
                arg(1)?.stringValue ?? "", arg(2)?.stringValue ?? ""))
        case "projected":
            return number(PortfolioCore.projectedAnnualInterest(
                arg(1)?.javaScriptNumber ?? 0, numeric(arg(2))))
        case "accrued":
            return number(PortfolioCore.calculateAccruedInterest(
                txns(arg(1)), arg(2)?.javaScriptNumber ?? 0, numeric(arg(3)),
                arg(4)?.stringValue ?? ""))
        case "costBasis":
            return costBasisWire(try PortfolioCore.calculateCostBasisByMethod(
                txns(arg(1)), arg(2)?.stringValue,
                opts: basisOptions(arg(3))))
        case "summary":
            return coreWire(try PortfolioCore.buildInvestmentSummaryCore(
                investment(arg(1)), txns(arg(2)), opts: options(arg(3))))
        case "summaryPartitioned":
            let result = try PortfolioCore.buildInvestmentSummaryCorePartitioned(
                investment(arg(1)), txns(arg(2)), opts: options(arg(3)))
            return .object(JSObject([
                ("core", coreWire(result.core)),
                ("partitions", .array(result.partitions.map { partition in
                    .object(JSObject([
                        ("accountId", partition.accountId.map { .number($0) } ?? .null),
                        ("contributionKind", .string(partition.contributionKind)),
                        ("core", coreWire(partition.core)),
                    ]))
                })),
                ("fullyAssigned", .bool(result.fullyAssigned)),
            ]))
        case "partition":
            return streamsWire(try PortfolioCustody.partitionTxnsByAccount(
                txns(arg(1)), method: arg(2)?.stringValue ?? "weighted_avg",
                opts: basisOptions(arg(3))).entries)
        case "custody":
            return streamsWire(try PortfolioCustody.projectAssetTransferPartitions(
                txns(arg(1)), method: arg(2)?.stringValue ?? "weighted_avg",
                opts: basisOptions(arg(3))).entries)
        case "oversell":
            let deficits = try PortfolioCore.partitionOversellDeficits(txns(arg(1)))
            var wire = JSObject()
            for key in deficits.keys.sorted() { wire[String(Int(key))] = .number(deficits[key] ?? 0) }
            return .object(wire)
        default:
            throw UnknownOperation(name: name)
        }
    }

    @Test func everyRecordedOperationIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        #expect(lines.count > 300)
        var failures: [String] = []
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"], let expected = recorded["r"] else {
                throw PlanFixture.Malformed(what: String(line))
            }
            let actual: JSValue
            do {
                actual = try Self.evaluate(op)
            } catch let error as PortfolioCore.Failure {
                actual = .string(error.message)
            } catch let error as DecimalJSError {
                actual = .string(error.description)
            } catch is UnknownOperation {
                throw PlanFixture.Malformed(what: String(line))
            }
            if actual != expected {
                failures.append("case \(index + 1) \(op.first?.stringValue ?? "")\n  expected \(expected.jsonText)\n  actual   \(actual.jsonText)")
            }
        }
        #expect(failures.isEmpty, "\(failures.count) of \(lines.count) differ:\n\(failures.prefix(3).joined(separator: "\n"))")
    }
}
