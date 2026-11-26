import Foundation
import VisionNativeCore

/// The half of `services/portfolio/portfolioSummaryService.getPortfolioSummary` a look-through
/// read consumes: the investment and transaction rows (`getRowsForPortfolioMath`), the FX
/// resolution (`latestMultipliers`, `annotateTransactionFxMultipliers` over the historical
/// rate index), the cost-basis method from settings, and the per-investment partitioned core
/// (`buildInvestmentSummaryCore`) behind each holding's converted `currentValue`. The P19
/// summary routes build on the same pieces.
enum PortfolioSummaryService {
    /// One holding as `aggregatePortfolioExposure` reads it: identity and converted value.
    struct Holding: Sendable {
        let id: Int  // lint:allow raw-id `InvestmentRow.id`, a table id the summary groups by
        let name: String
        let assetClass: String
        /// `round2(cv.currentValue)`, the summary field the aggregate's `money()` reads back.
        let currentValue: Double
    }

    struct Summary: Sendable {
        let currency: String
        let computedAt: String
        let holdings: [Holding]
        /// `totals.totalPortfolioValue`: round2 of the sum of the rounded per-holding values.
        let totalPortfolioValue: Double
    }

    /// One row of `getRowsForPortfolioMath`, before `annotateTransactionFxMultipliers` adds the
    /// `nativeCurrency`, `nativeFxMultiplier` and `fxMultiplier` of the FxAnnotatableRow.
    struct MathRow: Sendable {
        var id = "0"
        var investmentId: Int  // lint:allow raw-id the event's investment target
        var type: String
        var date = ""
        var amount = "0"
        var units = "0"
        var fees = "0"
        var taxes = "0"
        var currency = "EUR"
        var fxRateToEur: String?
        var accountId: String?  // lint:allow raw-id the driver's account id text
        var sourceAccountId: String?  // lint:allow raw-id the driver's account id text
        var destinationAccountId: String?  // lint:allow raw-id the driver's account id text
        var feeUnits = "0"
        var adjustmentKind: String?
        var basisPolicy: String?
        var eligibleSourceRecordHashes: [String?] = []
        var sourceRecordHash: String?
        var incomeRecognitionRole: String?
        var nativeCurrency: String?  // lint:allow raw-currency the row's unvalidated annotation column
        var nativeFxMultiplier: Double?
        var fxMultiplier: Double?
        var fellBack = false
    }

    /// A number the driver returns: `BigInt` ids (INTEGER columns) and NUMERIC text as
    /// strings, quoted-literal-free; NULL reads as the 0 the driver's coercion leaves.
    private static func numberText(_ row: SQLRow, _ column: String) -> String {
        if let number = try? row.optionalInt64(column) { return String(number) }
        if let text = try? row.text(column) { return text }
        return "0"
    }

    /// The row mapping of `portfolioMathTxRowSchema` (the driver's conversions).
    static func mathRow(_ row: SQLRow) -> MathRow {
        var out = MathRow(investmentId: (try? row.integerId("investment_id")) ?? 0, type: (try? row.text("type")) ?? "")
        out.id = numberText(row, "id")
        out.type = (try? row.text("type")) ?? ""
        out.date = (try? row.text("date")) ?? ""
        out.amount = numberText(row, "amount")
        out.units = numberText(row, "units")
        out.fees = numberText(row, "fees")
        out.taxes = numberText(row, "taxes")
        out.currency = (try? row.optionalText("currency")) ?? "EUR"
        out.fxRateToEur = try? row.optionalText("fx_rate_to_eur")
        out.accountId = (try? row.optionalText("account_id")).flatMap { $0.isEmpty ? nil : $0 }
        out.sourceAccountId = (try? row.optionalText("source_account_id")).flatMap { $0.isEmpty ? nil : $0 }
        out.destinationAccountId = (try? row.optionalText("destination_account_id")).flatMap { $0.isEmpty ? nil : $0 }
        out.feeUnits = numberText(row, "fee_units")
        out.adjustmentKind = try? row.optionalText("adjustment_kind")
        out.basisPolicy = try? row.optionalText("basis_policy")
        if let hashes = try? row.optionalText("eligible_source_record_hashes"), !hashes.isEmpty,
            case .array(let items)? = JSValue.parse(Data(hashes.utf8))
        {
            out.eligibleSourceRecordHashes = items.map { item -> String? in
                if case .string(let value) = item { return value }
                return nil
            }
        }
        out.sourceRecordHash = try? row.optionalText("source_record_hash")
        out.incomeRecognitionRole = try? row.optionalText("income_recognition_role")
        return out
    }

    /// `getRowsForPortfolioMath`: the three event tables as one ordered stream, with the
    /// filters the summary's `activeInvestmentsOnly` passes.
    static func mathRows(_ session: BackendSession, activeOnly: Bool = true) throws -> [MathRow] {
        let whereClause = activeOnly ? " WHERE i.is_active = 1" : ""
        return try session.rows(
            """
            SELECT * FROM (
            SELECT pt.id AS "id::bigint", pt.investment_id, pt.type AS type,
                   COALESCE(pt.amount, '0') AS amount, COALESCE(pt.units, '0') AS units,
                   COALESCE(pt.fees, '0') AS fees, COALESCE(pt.taxes, '0') AS taxes,
                   to_char(pt.date, 'YYYY-MM-DD') AS date, to_char(pt.date, 'YYYY-MM-DD') AS day,
                   COALESCE(pt.currency, i.currency, 'EUR') AS currency, pt.fx_rate_to_eur,
                   pt.account_id, NULL AS source_account_id,
                   NULL AS destination_account_id, '0' AS fee_units,
                   pt.source_record_hash, NULL AS adjustment_kind, NULL AS basis_policy,
                   NULL AS "eligible_source_record_hashes::json", pt.income_recognition_role
            FROM portfolio_transactions pt JOIN investments i ON i.id = pt.investment_id\(whereClause)
            UNION ALL
            SELECT at.id, at.investment_id, 'asset_transfer' AS type, '0' AS amount,
                   at.units, '0' AS fees, '0' AS taxes, to_char(at.date, 'YYYY-MM-DD') AS date,
                   to_char(at.date, 'YYYY-MM-DD') AS day, COALESCE(i.currency, 'EUR') AS currency,
                   NULL AS fx_rate_to_eur, NULL AS account_id,
                   at.source_account_id, at.destination_account_id, at.fee_units,
                   at.source_record_hash, NULL, NULL, NULL, 'standard'
            FROM portfolio_asset_transfers at JOIN investments i ON i.id = at.investment_id\(whereClause)
            UNION ALL
            SELECT aa.id, aa.investment_id, 'asset_adjustment', '0', aa.units, '0', '0',
                   to_char(aa.date, 'YYYY-MM-DD'), to_char(aa.date, 'YYYY-MM-DD'), COALESCE(i.currency, 'EUR'),
                   NULL, aa.account_id, NULL, NULL, '0', aa.source_record_hash,
                   aa.adjustment_kind, aa.basis_policy, aa.eligible_source_record_hashes, 'standard'
            FROM portfolio_asset_adjustments aa JOIN investments i ON i.id = aa.investment_id\(whereClause)
            ) events ORDER BY events.date, events."id::bigint"
            """).map(mathRow)
    }

    /// The investments of `getPortfolioSummary`'s first query — its `COALESCE` overrides
    /// applied — ordered by name.
    static func investments(_ session: BackendSession, activeOnly: Bool = true) throws -> [SQLRow] {
        try session.rows(
            """
            SELECT i.*, COALESCE(i.currency, 'EUR') AS currency, \
            COALESCE(i.current_price, '0') AS current_price, COALESCE(i.interest_rate, '0') AS interest_rate \
            FROM investments i\(activeOnly ? " WHERE i.is_active = 1" : "") ORDER BY i.name
            """)
    }

    /// `resolveCostBasisMethod`: the stored setting, `weighted_avg` when missing or malformed.
    static func costBasisMethod(_ session: BackendSession) -> String {
        guard let stored = try? SettingsArea.get(session, key: "cost_basis_method"),
            case .string(let value) = stored,
            PortfolioCore.isCostBasisMethod(value)
        else { return "weighted_avg" }
        return value
    }

    /// `annotateTransactionFxMultipliers`: transaction-date FX per row, the stamped
    /// `fx_rate_to_eur` preferred, with the latest stored rate as the flagged fallback.
    static func annotate(
        _ rows: inout [MathRow], investmentCurrency: [Int: String],  // lint:allow raw-id investment ids
        target: String, index: [String: [(day: String, rate: Double)]], multipliers: [String: Double]
    ) {
        for position in rows.indices {
            let txnCurrency = AccountsArea.storedCurrencyCode(rows[position].currency)
            let nativeCurrency = investmentCurrency[rows[position].investmentId] ?? txnCurrency
            rows[position].nativeCurrency = nativeCurrency
            let stampedRate = JavaScriptNumber.fromString(
                (try? rows[position].fxRateToEur.flatMap { $0.isEmpty ? nil : $0 }) ?? nil ?? "")
            let rateFrom: Double?
            if txnCurrency == "EUR" {  // lint:allow string-literal-compare the fixed base currency of the FX index
                rateFrom = 1
            } else if stampedRate.isFinite && stampedRate > 0 {
                rateFrom = stampedRate
            } else {
                rateFrom = PricesArea.findRate(index, txnCurrency, rows[position].date)
            }
            if txnCurrency == nativeCurrency {
                rows[position].nativeFxMultiplier = 1
            } else {
                let rateNative = PricesArea.findRate(index, nativeCurrency, rows[position].date)
                if let rateFrom, let rateNative = rateNative, rateNative > 0 {
                    rows[position].nativeFxMultiplier = rateFrom / rateNative
                } else {
                    rows[position].nativeFxMultiplier =
                        (multipliers[txnCurrency] ?? 1) / (multipliers[nativeCurrency] ?? 1)
                    rows[position].fellBack = true
                }
            }
            if txnCurrency == target {
                rows[position].fxMultiplier = 1
                continue
            }
            let rateTo = target == "EUR" ? 1 : PricesArea.findRate(index, target, rows[position].date)  // lint:allow string-literal-compare the fixed base currency of the FX index
            if let rateFrom, let rateTo = rateTo, rateTo > 0 {
                rows[position].fxMultiplier = rateFrom / rateTo
            } else {
                rows[position].fxMultiplier = multipliers[txnCurrency] ?? 1
                rows[position].fellBack = true
            }
        }
    }

    /// The row as the core replays it, the annotation applied.
    static func txn(_ row: MathRow) -> PortfolioCore.Txn {
        PortfolioCore.Txn(
            id: JavaScriptNumber.fromString(row.id), type: row.type, date: row.date,
            fxMultiplier: row.fxMultiplier.map { PortfolioCore.Numeric.number($0) },
            nativeFxMultiplier: row.nativeFxMultiplier.map { PortfolioCore.Numeric.number($0) },
            nativeCurrency: row.nativeCurrency,
            units: .text(row.units), amount: .text(row.amount),
            fees: .text(row.fees), taxes: .text(row.taxes),
            incomeRecognitionRole: row.incomeRecognitionRole,
            accountId: row.accountId.map { JavaScriptNumber.fromString($0) },
            sourceAccountId: row.sourceAccountId.map { JavaScriptNumber.fromString($0) },
            destinationAccountId: row.destinationAccountId.map { JavaScriptNumber.fromString($0) },
            feeUnits: .text(row.feeUnits),
            adjustmentKind: row.adjustmentKind, basisPolicy: row.basisPolicy,
            eligibleSourceRecordHashes: row.eligibleSourceRecordHashes,
            sourceRecordHash: row.sourceRecordHash, currency: row.currency)
    }

    /// `getPortfolioSummary` reduced to what a look-through read needs: every holding's
    /// converted `currentValue` and the portfolio total.
    static func summary(_ session: BackendSession, target: String = "EUR") throws -> Summary {
        let targetCurrency = target.uppercased()
        let investmentRows = try investments(session)

        var investmentCurrency: [Int: String] = [:]  // lint:allow raw-id investment ids
        var currencies: [String] = []
        for row in investmentRows {
            let id = try row.integerId("id")
            let code = AccountsArea.storedCurrencyCode(try row.text("currency"))
            investmentCurrency[id] = code
            if !currencies.contains(code) { currencies.append(code) }
        }
        var rows = try mathRows(session)
        for position in rows.indices {
            let code = AccountsArea.storedCurrencyCode(rows[position].currency)
            if !currencies.contains(code) { currencies.append(code) }
        }
        let latest = try AccountsArea.latestRatesToEur(session)
        var multipliers: [String: Double] = [:]
        for currency in currencies {
            if currency == targetCurrency {
                multipliers[currency] = 1
            } else {
                multipliers[currency] = PricesArea.latestConvert(1, currency, targetCurrency, latest) ?? 1
            }
        }
        let index = try PricesArea.historicalRateIndex(session, currencies: currencies + [targetCurrency])
        annotate(&rows, investmentCurrency: investmentCurrency, target: targetCurrency, index: index, multipliers: multipliers)

        let method = costBasisMethod(session)
        let today = session.today()
        var byId: [Int: [PortfolioCore.Txn]] = [:]  // lint:allow raw-id investment ids
        for row in rows {
            byId[row.investmentId, default: []].append(txn(row))
        }
        var holdings: [Holding] = []
        var total = DecimalJS.zero
        for row in investmentRows {
            let id = try row.integerId("id")
            let currency = AccountsArea.storedCurrencyCode(try row.text("currency"))
            let multiplier = multipliers[currency] ?? 1
            let investment = PortfolioCore.Investment(
                assetClass: try row.text("asset_class"),
                currentPrice: .text(try row.text("current_price")),
                interestRate: .text(try row.text("interest_rate")))
            let options = PortfolioCore.Options(
                costBasisMethod: method, todayYmd: today, fxMultiplierNow: .number(multiplier))
            let core = try PortfolioCore.buildInvestmentSummaryCorePartitioned(
                investment, byId[id] ?? [], opts: options)
            // `round2`, the summary field's emission: Number(toString of 2dp half-even).
            let roundedText = core.core.converted.currentValue.toDecimalPlaces(2, .halfEven)
                .javaScriptString
            let rounded = JavaScriptNumber.fromString(roundedText)
            holdings.append(
                Holding(
                    id: id, name: try row.text("name"), assetClass: try row.text("asset_class"),
                    currentValue: rounded))
            total = total.plus((try? DecimalJS(rounded)) ?? .zero)
        }
        return Summary(
            currency: targetCurrency,
            computedAt: try SQLTimestamps.formatInstant(session.currentInstant()),
            holdings: holdings,
            totalPortfolioValue: JavaScriptNumber.fromString(
                total.toDecimalPlaces(2, .halfEven).javaScriptString))
    }
}
