import Foundation

/// `portfolioTax.ts`, `costBreakdown.ts` and `portfolioDashboard.ts`: the taxes and fees a
/// portfolio recorded in a year and the estimates the tax dashboard shows beside them. Sums go
/// through the decimal type, as the TypeScript does; an amount that is not finite throws
/// `DecimalError`, where decimal.js carries NaN through.
enum PortfolioTaxDashboard {
    /// `MaybeConvertFn`: the amount in the dashboard currency, `nil` when no rate is known.
    typealias Convert = (Double, String?) -> Double?
    private typealias Converted = (Double, String?) -> Double

    /// `UnconvertedFigures`.
    private final class Missing {
        var currencies: Set<String> = []
        var figures: Set<String> = []
    }

    /// `numberOrZero(value)`.
    private static func number(_ value: JSValue?) -> Double { TaxMath.orZero(value.map(\.javaScriptNumber)) }

    /// `Number.parseInt(text.slice(0, 4), 10)`; `nil` is NaN.
    private static func leadingYear(_ date: String?) -> Double? {
        guard let date else { return nil }
        var scalars = Array(date.unicodeScalars.prefix(4))[...]
        while let first = scalars.first, JavaScriptWhitespace.contains(first) { scalars = scalars.dropFirst() }
        var sign = 1.0
        if let first = scalars.first, first == "-" || first == "+" {
            if first == "-" { sign = -1 }
            scalars = scalars.dropFirst()
        }
        var value = 0.0
        var digits = 0
        for scalar in scalars {
            guard scalar.value >= 48, scalar.value <= 57 else { break }
            value = value * 10 + Double(scalar.value - 48)
            digits += 1
        }
        return digits == 0 ? nil : sign * value
    }

    private static func isYear(_ transaction: JSObject, _ year: Double) -> Bool {
        leadingYear(transaction.text("date")) == year
    }

    private static func transactions(_ investment: JSObject) throws -> [JSObject] {
        guard case .array(let items)? = investment["transactions"] else {
            throw BelgianTaxError.malformed("transactions")
        }
        return items.map { $0.objectValue ?? JSObject() }
    }

    private static func sum(_ terms: [Double]) throws -> DecimalJS {
        try terms.reduce(DecimalJS.zero) { try $0.plus(DecimalJS($1)) }
    }

    private static func isType(_ transaction: JSObject, _ type: String) -> Bool { transaction["type"] == .string(type) }

    /// `recordedForYear(inv, txYear, convert, txnType, field)`.
    private static func recorded(
        _ investment: JSObject, _ year: Double, _ convert: Converted, type: String, field: String
    ) throws -> Double {
        var terms: [Double] = []
        for transaction in try transactions(investment) where isYear(transaction, year) {
            let currency = transaction.text("currency")
            if isType(transaction, type) { terms.append(convert(number(transaction["amount"]), currency)) }
            terms.append(convert(number(transaction[field]), currency))
        }
        return try sum(terms).toNumber
    }

    private static func exchangeTaxRate(_ investment: JSObject, _ table: BelgianTaxTable) -> BelgianTaxTable.RateAndCap? {
        switch investment.text("assetClass") {
        case "bond": return table.tob.bonds
        case "stock": return table.tob.sharesAndOther
        case "etf":
            return investment["etfStructure"] == .string("distributing")
                ? table.tob.distributingFunds : table.tob.accumulatingFunds
        default: return nil
        }
    }

    /// `statutoryTob(params, txn, convert)`.
    private static func statutoryExchangeTax(
        _ parameters: BelgianTaxTable.RateAndCap, _ transaction: JSObject, _ convert: Converted
    ) throws -> DecimalJS {
        let amount = convert(number(transaction["amount"]).magnitude, transaction.text("currency"))
        return DecimalJS.min(try DecimalJS(amount).times(DecimalJS(parameters.rate)), try DecimalJS(parameters.cap))
    }

    /// `recordedSellTob(inv, txn, taxTable, convert, cgtActive)`.
    private static func recordedSellExchangeTax(
        _ investment: JSObject, _ transaction: JSObject, _ table: BelgianTaxTable, _ convert: Converted,
        gainsTaxActive: Bool
    ) throws -> Double {
        guard isType(transaction, "sell"), let parameters = exchangeTaxRate(investment, table) else { return 0 }
        let taxes = convert(number(transaction["taxes"]), transaction.text("currency"))
        if taxes <= 0 { return 0 }
        if !gainsTaxActive { return taxes }
        return DecimalJS.min(try DecimalJS(taxes), try statutoryExchangeTax(parameters, transaction, convert)).toNumber
    }

    private static func entries(_ values: [(String, Double)]) -> JSValue {
        .array(
            values.filter { $0.1 > 0 }.map {
                .object(JSObject([("nameKey", .string($0.0)), ("value", TaxJSON.number($0.1))]))
            })
    }

    /// A stable sort, as JavaScript's `sort` is.
    private static func stableSorted<Item>(_ items: [Item], by precedes: (Item, Item) -> Bool) -> [Item] {
        items.enumerated().sorted { a, b in
            if precedes(a.element, b.element) { return true }
            if precedes(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// `buildPortfolioTaxDashboard(input)`.
    static func build(
        summaries input: [JSObject], year: Double, currency: String, totalPIT: Double, filingStatus: String,
        hasProfile: Bool, adjustments: JSValue?, classifications: JSValue?, convert: @escaping Convert
    ) throws -> JSValue {
        let number = TaxJSON.number
        let missing = Missing()
        func converter(_ figures: String...) -> Converted {
            { amount, currency in
                if let value = convert(amount, currency) { return value }
                if amount != 0 {
                    missing.currencies.insert((currency ?? "EUR").uppercased())
                    missing.figures.formUnion(figures)
                }
                return 0
            }
        }
        let convertCosts = converter("totals", "taxByAssetClass", "investmentBreakdown")
        let adjustments = adjustments?.objectValue ?? JSObject()
        let classifications = classifications?.objectValue ?? JSObject()
        let yearText = JavaScriptNumber.text(year)
        let summaries = input.map { investment -> JSObject in
            var merged = investment
            let id = investment["id"]?.javaScriptString ?? "undefined"
            for (key, value) in classifications[id]?.objectValue?.entries ?? [] { merged[key] = value }
            return merged
        }

        /// `InvestmentCosts`.
        struct Costs {
            var recordedTaxes: Double
            var recordedFees: Double
            var manualTaxes: Double
            var manualFees: Double
            var taxes: Double
            var fees: Double
            var total: Double
        }
        let costs = try summaries.map { investment -> Costs in
            let id = investment["id"]?.javaScriptString ?? "undefined"
            let manual = adjustments[yearText + ":" + id]?.objectValue ?? JSObject()
            let manualTaxes = Self.number(manual["taxes"])
            let manualFees = Self.number(manual["fees"])
            let recordedTaxes = try recorded(investment, year, convertCosts, type: "tax", field: "taxes")
            let recordedFees = try recorded(investment, year, convertCosts, type: "fee", field: "fees")
            let taxes = try DecimalJS(recordedTaxes).plus(DecimalJS(manualTaxes)).toNumber
            let fees = try DecimalJS(recordedFees).plus(DecimalJS(manualFees)).toNumber
            return Costs(
                recordedTaxes: recordedTaxes, recordedFees: recordedFees, manualTaxes: manualTaxes,
                manualFees: manualFees, taxes: taxes, fees: fees,
                total: try DecimalJS(taxes).plus(DecimalJS(fees)).toNumber)
        }
        let totalTaxes = TaxMath.sum(costs, \.taxes)
        let totalFees = TaxMath.sum(costs, \.fees)
        let totalManualTaxes = TaxMath.sum(costs, \.manualTaxes)
        let totalManualFees = TaxMath.sum(costs, \.manualFees)
        let convertTotals = converter("totals")
        func gain(_ key: String) -> Double {
            TaxMath.sum(summaries) { convertTotals(TaxMath.orZero($0.number(key)), $0.text("currency")) }
        }
        let totalRealizedGain = gain("realizedGain")
        let totalUnrealizedGain = gain("unrealizedGain")
        let table = BelgianTaxTable.table(for: year)
        let gainsTaxActive = table.capitalGainsTaxRate > 0

        // `buildPortfolioCostBreakdowns`
        let convertBreakdowns = converter("taxBreakdown", "feeBreakdown")
        var gainsTax = 0.0
        var withholding = 0.0
        var transactionTax = 0.0
        var otherTaxes = 0.0
        var brokerFees = 0.0
        var managementFees = 0.0
        var otherFees = 0.0
        for investment in summaries {
            for transaction in try transactions(investment) where isYear(transaction, year) {
                let currency = transaction.text("currency")
                let taxes = convertBreakdowns(Self.number(transaction["taxes"]), currency)
                if isType(transaction, "sell"), taxes > 0 {
                    let exchangeTax = try recordedSellExchangeTax(
                        investment, transaction, table, convertBreakdowns, gainsTaxActive: gainsTaxActive)
                    if exchangeTax > 0 { transactionTax += exchangeTax }
                    if taxes - exchangeTax > 0 {
                        if gainsTaxActive { gainsTax += taxes - exchangeTax } else { otherTaxes += taxes - exchangeTax }
                    }
                } else if isType(transaction, "dividend"), taxes > 0 {
                    withholding += taxes
                } else if isType(transaction, "buy"), taxes > 0 {
                    transactionTax += taxes
                } else if isType(transaction, "tax") {
                    otherTaxes += convertBreakdowns(Self.number(transaction["amount"]), currency)
                } else if taxes > 0 {
                    otherTaxes += taxes
                }
                let fees = convertBreakdowns(Self.number(transaction["fees"]), currency)
                if isType(transaction, "buy") || isType(transaction, "sell"), fees > 0 {
                    brokerFees += fees
                } else if isType(transaction, "fee") {
                    managementFees += convertBreakdowns(Self.number(transaction["amount"]), currency)
                } else if fees > 0 {
                    otherFees += fees
                }
            }
        }

        var assetClasses: [String] = []
        var byAsset: [String: (taxes: Double, fees: Double)] = [:]
        for (investment, cost) in zip(summaries, costs) {
            let assetClass = investment["assetClass"]?.javaScriptString ?? "undefined"
            if byAsset[assetClass] == nil { assetClasses.append(assetClass) }
            var bucket = byAsset[assetClass] ?? (0, 0)
            bucket.taxes += cost.taxes
            bucket.fees += cost.fees
            byAsset[assetClass] = bucket
        }
        var periods: [String] = []
        var months: [String: (taxes: Double, fees: Double)] = [:]
        let convertTrend = converter("yearlyCostTrend")
        for investment in summaries {
            for transaction in try transactions(investment) where isYear(transaction, year) {
                guard let date = transaction.text("date"), !date.isEmpty else { continue }
                let period = String(decoding: Array(date.utf16.prefix(7)), as: UTF16.self)
                if months[period] == nil { periods.append(period) }
                var month = months[period] ?? (0, 0)
                let currency = transaction.text("currency")
                if isType(transaction, "tax") { month.taxes += convertTrend(Self.number(transaction["amount"]), currency) }
                month.taxes += convertTrend(Self.number(transaction["taxes"]), currency)
                if isType(transaction, "fee") { month.fees += convertTrend(Self.number(transaction["amount"]), currency) }
                month.fees += convertTrend(Self.number(transaction["fees"]), currency)
                months[period] = month
            }
        }

        // `computeRealizedGainSplit`
        let convertSplit = converter("estimates.reyndersEstimate", "estimates.cgtEstimate")
        var reyndersInterest = DecimalJS.zero
        var taxedGains = DecimalJS.zero
        for investment in summaries {
            let amount = convertSplit(Self.number(investment["realizedGain"]), investment.text("currency"))
            if amount <= 0 { continue }
            let gain = try DecimalJS(amount)
            let isBond = investment["assetClass"] == .string("bond")
            let override = investment["subjectToReynders"]
            let subject = override == nil || override == .null ? isBond : FormulaSemantics.truthy(override)
            if subject {
                var portion = 1.0
                if let raw = investment.number("reyndersInterestPortion"), raw >= 0, raw <= 1 { portion = raw }
                reyndersInterest = reyndersInterest.plus(gain.times(try DecimalJS(portion)))
                if gainsTaxActive { taxedGains = taxedGains.plus(gain.times(try DecimalJS(1 - portion))) }
            } else if !isBond || gainsTaxActive {
                taxedGains = taxedGains.plus(gain)
            }
        }
        let split = (reyndersInterest: reyndersInterest.toNumber, gains: taxedGains.toNumber)

        // `computeDividendWht`
        let convertDividend = converter("dividend")
        var incomeTerms: [Double] = []
        var withheldTerms: [Double] = []
        var grossTerms: [Double] = []
        var unknownConventions = 0
        for investment in summaries {
            for transaction in try transactions(investment)
            where isYear(transaction, year) && isType(transaction, "dividend")
                && transaction["income_recognition_role"] != .string("included_in_units")
            {
                let currency = transaction.text("currency")
                let amount = convertDividend(Self.number(transaction["amount"]), currency)
                let taxes = convertDividend(Self.number(transaction["taxes"]), currency)
                incomeTerms.append(amount)
                withheldTerms.append(taxes)
                switch transaction.text("dividend_amount_convention") {
                case "gross": grossTerms.append(amount)
                case "net": grossTerms.append(amount + taxes)
                default: unknownConventions += 1
                }
            }
        }
        let married = filingStatus == "married_joint"
        let withheld = try sum(withheldTerms)
        let grossBase = unknownConventions > 0 ? nil : try sum(grossTerms)
        let dividendExemption = try DecimalJS(table.dividendExemption)
        let exemption = married ? dividendExemption.times(DecimalJS(2)) : dividendExemption
        let withholdingRate = try DecimalJS(table.dividendWHTRate)
        let reclaim = grossBase.map { DecimalJS.min(withheld, DecimalJS.min($0, exemption).times(withholdingRate)) }
        let netCost = reclaim.map { DecimalJS.max(withheld.minus($0), .zero) }
        func optional(_ value: DecimalJS?) -> JSValue { value.map { number($0.toNumber) } ?? .null }
        let dividend = TaxJSON.object([
            ("totalDividendIncome", number(try sum(incomeTerms).toNumber)),
            ("dividendWhtRecorded", number(withheld.toNumber)), ("grossDividendBase", optional(grossBase)),
            ("grossDividendWht", number(withheld.toNumber)), ("dividendWhtReclaim", optional(reclaim)),
            ("dividendWhtNetCost", optional(netCost)), ("unknownDividendConventionCount", .int(unknownConventions)),
            ("dividendExemption", number(table.dividendExemption)),
        ])

        // Estimates
        let convertRecorded = converter("estimates.tobRecorded")
        var recordedTerms: [Double] = []
        let convertAuto = converter("estimates.tobAutoEstimate")
        var autoLegs: [DecimalJS] = []
        for investment in summaries {
            for transaction in try transactions(investment) where isYear(transaction, year) {
                if isType(transaction, "buy") {
                    recordedTerms.append(
                        convertRecorded(Self.number(transaction["taxes"]), transaction.text("currency")))
                } else if isType(transaction, "sell") {
                    recordedTerms.append(
                        try recordedSellExchangeTax(
                            investment, transaction, table, convertRecorded, gainsTaxActive: gainsTaxActive))
                }
            }
        }
        for investment in summaries {
            guard let parameters = exchangeTaxRate(investment, table) else { continue }
            for transaction in try transactions(investment)
            where (isType(transaction, "buy") || isType(transaction, "sell")) && isYear(transaction, year) {
                autoLegs.append(try statutoryExchangeTax(parameters, transaction, convertAuto))
            }
        }
        let convertAccount = converter("estimates.tacrEstimate")
        let accountValue = try sum(
            summaries.map { convertAccount(Self.number($0["currentValue"]), $0.text("currency")) })
        let accountTax =
            accountValue.lt(try DecimalJS(table.securitiesAccountTaxThreshold))
            ? 0 : accountValue.times(try DecimalJS(table.securitiesAccountTaxRate)).toNumber
        var reyndersEstimate = 0.0
        if TaxMath.isNonZero(table.reyndersTaxRate), split.reyndersInterest > 0 {
            reyndersEstimate = try DecimalJS(split.reyndersInterest).times(DecimalJS(table.reyndersTaxRate)).toNumber
        }
        var gainsEstimate = 0.0
        if gainsTaxActive, split.gains > 0 {
            let exempt = married ? table.capitalGainsTaxExemptionMarried : table.capitalGainsTaxExemptionSingle
            gainsEstimate =
                DecimalJS.max(try DecimalJS(split.gains).minus(DecimalJS(exempt)), .zero)
                .times(try DecimalJS(table.capitalGainsTaxRate)).toNumber
        }
        let estimates = TaxJSON.object([
            ("tobRecorded", number(try sum(recordedTerms).toNumber)),
            ("tobAutoEstimate", number(autoLegs.reduce(DecimalJS.zero) { $0.plus($1) }.toNumber)),
            ("tacrEstimate", number(accountTax)), ("reyndersEstimate", number(reyndersEstimate)),
            ("cgtEstimate", number(gainsEstimate)),
        ])

        let convertRealized = converter("investmentBreakdown")
        let yearPrefix = yearText + "-"
        let hasInKindIncome = try summaries.contains { investment in
            try transactions(investment).contains {
                $0["income_recognition_role"] == .string("included_in_units")
                    && ($0.text("date")?.hasPrefix(yearPrefix) ?? false)
            }
        }
        func symbol(_ investment: JSObject) -> JSValue { investment["symbol"] ?? .null }
        typealias AssetRow = (assetClass: String, taxes: Double, fees: Double, total: Double)
        var unsortedAssetRows: [AssetRow] = []
        for assetClass in assetClasses {
            let bucket: (taxes: Double, fees: Double) = byAsset[assetClass] ?? (0, 0)
            let total: Double = bucket.taxes + bucket.fees
            if total > 0 { unsortedAssetRows.append((assetClass, bucket.taxes, bucket.fees, total)) }
        }
        let assetRows: [AssetRow] = stableSorted(unsortedAssetRows) { $0.total > $1.total }
        // Every investment's gain is converted, also those the breakdown then leaves out.
        let realizedGains = summaries.map {
            convertRealized(TaxMath.orZero($0.number("realizedGain")), $0.text("currency"))
        }
        typealias InvestmentRow = (investment: JSObject, cost: Costs, realizedGain: Double)
        var unsortedInvestmentRows: [InvestmentRow] = []
        for index in summaries.indices where costs[index].total > 0 {
            unsortedInvestmentRows.append((summaries[index], costs[index], realizedGains[index]))
        }
        let investmentRows: [InvestmentRow] = stableSorted(unsortedInvestmentRows) { $0.cost.total > $1.cost.total }
        let percent = TaxJSON.object([
            ("securitiesAccountTaxRate", number(table.securitiesAccountTaxRate * 100)),
            ("capitalGainsTaxRate", number(table.capitalGainsTaxRate * 100)),
            ("reyndersTaxRate", number(table.reyndersTaxRate * 100)),
            ("dividendWHTRate", number(table.dividendWHTRate * 100)),
        ])
        func texts(_ values: Set<String>) -> JSValue {
            .array(values.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map(JSValue.string))
        }
        return TaxJSON.object([
            ("year", number(year)), ("currency", .string(currency)), ("isEmpty", .bool(summaries.isEmpty)),
            ("hasProfile", .bool(hasProfile)), ("hasInKindIncomeUnclassified", .bool(hasInKindIncome)),
            (
                "totals",
                TaxJSON.object([
                    ("totalTaxes", number(totalTaxes)), ("totalFees", number(totalFees)),
                    ("totalTaxesAndFees", number(totalTaxes + totalFees)),
                    ("totalRecordedTaxes", number(TaxMath.sum(costs, \.recordedTaxes))),
                    ("totalRecordedFees", number(TaxMath.sum(costs, \.recordedFees))),
                    ("totalManualTaxes", number(totalManualTaxes)), ("totalManualFees", number(totalManualFees)),
                    ("totalManualCosts", number(totalManualTaxes + totalManualFees)),
                    ("totalRealizedGain", number(totalRealizedGain)),
                    ("totalUnrealizedGain", number(totalUnrealizedGain)),
                    ("effectiveTaxRate", number(totalRealizedGain > 0 ? (totalTaxes / totalRealizedGain) * 100 : 0)),
                    ("totalPIT", number(totalPIT)), ("portfolioTaxesPlusPIT", number(totalPIT + totalTaxes)),
                ])
            ),
            (
                "taxBreakdown",
                entries([
                    ("tax.capitalGainsTax", gainsTax), ("tax.dividendWithholding", withholding),
                    ("tax.transactionTax", transactionTax), ("tax.otherTaxes", otherTaxes),
                    ("tax.manualTaxAdjustments", totalManualTaxes),
                ])
            ),
            (
                "feeBreakdown",
                entries([
                    ("tax.brokerFees", brokerFees), ("tax.managementFees", managementFees), ("tax.otherFees", otherFees),
                    ("tax.manualFeeAdjustments", totalManualFees),
                ])
            ),
            (
                "taxByAssetClass",
                .array(
                    assetRows.map {
                        TaxJSON.object([
                            ("assetClass", .string($0.0)), ("taxes", number($0.1)), ("fees", number($0.2)),
                            ("total", number($0.3)),
                        ])
                    })
            ),
            (
                "investmentBreakdown",
                .array(
                    investmentRows.map { investment, cost, realizedGain in
                        TaxJSON.object([
                            ("id", investment["id"]), ("name", investment["name"]), ("symbol", symbol(investment)),
                            ("assetClass", investment["assetClass"]), ("recordedTaxes", number(cost.recordedTaxes)),
                            ("recordedFees", number(cost.recordedFees)), ("manualTaxes", number(cost.manualTaxes)),
                            ("manualFees", number(cost.manualFees)), ("taxes", number(cost.taxes)),
                            ("fees", number(cost.fees)), ("total", number(cost.total)),
                            ("realizedGain", number(realizedGain)), ("currency", .string(currency)),
                        ])
                    })
            ),
            (
                "yearlyCostTrend",
                .array(
                    periods.sorted(by: TaxMath.precedes).map { period in
                        let month = months[period] ?? (0, 0)
                        return TaxJSON.object([
                            ("period", .string(period)), ("taxes", number(month.taxes)), ("fees", number(month.fees)),
                        ])
                    })
            ),
            ("dividend", dividend), ("estimates", estimates),
            (
                "taxTable",
                TaxJSON.object([
                    ("securitiesAccountTaxRate", number(table.securitiesAccountTaxRate)),
                    ("capitalGainsTaxRate", number(table.capitalGainsTaxRate)),
                    ("reyndersTaxRate", number(table.reyndersTaxRate)), ("dividendWHTRate", number(table.dividendWHTRate)),
                    ("securitiesAccountTaxThreshold", number(table.securitiesAccountTaxThreshold)),
                    ("badgePercent", percent),
                ])
            ),
            (
                "summaries",
                .array(
                    summaries.map {
                        TaxJSON.object([
                            ("id", $0["id"]), ("name", $0["name"]), ("symbol", symbol($0)),
                            ("assetClass", $0["assetClass"]), ("currency", $0["currency"] ?? .string("EUR")),
                        ])
                    })
            ),
            ("unconvertedCurrencies", texts(missing.currencies)), ("incompleteFigures", texts(missing.figures)),
        ])
    }
}
