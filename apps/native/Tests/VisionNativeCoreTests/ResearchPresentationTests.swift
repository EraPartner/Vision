import Foundation
import Testing

@testable import VisionNativeCore

private func decode(_ text: String) throws -> TaxValue {
    try JSONDecoder().decode(TaxValue.self, from: Data(text.utf8))
}
private func dec(_ text: String) -> TaxValue { .number(Decimal(string: text)!) }
private func sameJSON(_ a: TaxValue, _ b: TaxValue, tolerance: Double = 0) -> Bool {
    switch (a, b) {
    case (.number(let x), .number(let y)):
        if tolerance == 0 { return x == y }
        let left = NSDecimalNumber(decimal: x).doubleValue
        let right = NSDecimalNumber(decimal: y).doubleValue
        return abs(left - right) <= tolerance * max(1, abs(right))
    case (.array(let x), .array(let y)):
        return x.count == y.count && zip(x, y).allSatisfy { sameJSON($0, $1, tolerance: tolerance) }
    case (.object(let x), .object(let y)):
        return Set(x.keys) == Set(y.keys) && x.allSatisfy { sameJSON($0.value, y[$0.key]!, tolerance: tolerance) }
    default:
        return a == b
    }
}
private func compute(_ json: String) throws -> TaxValue {
    try #require(try ResearchPresentation.compute(decode(json))["result"])
}
private func rejected(_ json: String) throws -> Bool {
    let input = try decode(json)
    do {
        _ = try ResearchPresentation.compute(input)
        return false
    } catch is ResearchPresentationError {
        return true
    }
}

/// Ports of apps/frontend/src/lib/research/__tests__/{presentation,indicators}.test.ts and
/// apps/frontend/src/lib/__tests__/portfolioUnitMath.test.ts (deriveUnitMath), with the same fixtures
/// and expected values, plus the Zod input schema of the removed presentation route.
@Suite("Research presentation port")
struct ResearchPresentationTests {
    // MARK: presentation.test.ts

    @Test func sharedSourceGoldensMatchTheTypeScriptOutput() throws {
        let golden = try decode(researchPresentationGoldenJSON)
        let cases = try #require(golden["cases"]?.arrayValue)
        #expect(cases.count == 4)
        for item in cases {
            var input = try #require(item["input"])
            if input["oscillatorSeriesId"] == nil { input["oscillatorSeriesId"] = .null }
            let kind = try #require(input["kind"])
            let actual = try ResearchPresentation.compute(input)
            let expected = TaxValue.object(["kind": kind, "result": try #require(item["expected"])])
            // Compare statistics use Math.log, which a platform libm may round one ulp differently.
            let tolerance = kind == .string("compare") ? 1e-12 : 0
            let name = item["name"]?.stringValue ?? ""
            #expect(sameJSON(actual, expected, tolerance: tolerance), Comment(rawValue: name))
        }
    }
    @Test func distinctListChartPreviewTargetConventionsAndFirstZeroProviderQuote() throws {
        let watchlist = try compute(
            #"{"kind":"watchlist","targetPrice":10,"currentPrice":8,"addedPrice":4,"points":[]}"#)
        #expect(
            sameJSON(
                watchlist,
                .object([
                    "list": .object([
                        "distancePercent": .number(-20), "absoluteDistancePercent": .number(20),
                        "isAtOrBelowTarget": .bool(true), "sinceAddedPercent": .number(100),
                    ]),
                    "chart": .object([
                        "distancePercent": .number(-20), "absoluteDistancePercent": .number(20),
                        "isAtOrBelowTarget": .bool(true), "hasValidTarget": .bool(true),
                        "domain": .array([dec("9.8"), dec("10.2")]),
                    ]),
                    "preview": .object(["absolutePercent": .number(25), "direction": .string("above")]),
                ])))
        let atTarget = try compute(
            #"{"kind":"watchlist","targetPrice":8,"currentPrice":8,"addedPrice":null,"points":[]}"#)
        #expect(atTarget["preview"] == .object(["absolutePercent": .number(0), "direction": .string("above")]))
        let noTarget = try compute(
            #"{"kind":"watchlist","targetPrice":0,"currentPrice":8,"addedPrice":null,"points":[]}"#)
        #expect(
            noTarget["chart"]
                == .object([
                    "distancePercent": .null, "absoluteDistancePercent": .null, "isAtOrBelowTarget": .bool(false),
                    "hasValidTarget": .bool(false), "domain": .array([.number(0), .number(1)]),
                ]))
        let quote = try compute(
            #"{"kind":"providerQuote","points":[{"time":1,"close":0},{"time":2,"close":8}],"investment":{"name":"Metal","currency":"USD","priceProvider":"kinesis"}}"#
        )
        #expect(quote["price"] == .number(8))
        #expect(quote["change"] == .number(8))
        #expect(quote["changePercent"] == .number(0))
        #expect(quote["type"] == .string("KINESIS"))
        #expect(quote["currency"] == .string("USD"))
        #expect(quote["symbol"] == .string(""))
    }
    @Test func providerQuoteKeepsNullCoercionAndFallsBackToTheSelectedSymbol() throws {
        let quote = try compute(
            #"{"kind":"providerQuote","selectedSymbol":"SYN","points":[{"time":1,"close":null},{"time":2,"close":null}],"investment":{"symbol":null,"name":"N","currency":"EUR"}}"#
        )
        #expect(quote["price"] == .null)
        #expect(quote["change"] == .number(0))
        #expect(quote["changePercent"] == .number(0))
        #expect(quote["symbol"] == .string("SYN"))
        #expect(quote["type"] == .string(""))
        #expect(try compute(#"{"kind":"providerQuote","points":[],"investment":{"name":"N","currency":"EUR"}}"#) == .null)
    }
    @Test func consensusThresholdsAndTwoOfThreeRoundingAndTolerance() throws {
        let bull = try compute(
            #"{"kind":"analyst","consensus":{"strongBuy":6,"buy":0,"hold":4,"sell":0,"strongSell":0}}"#)
        #expect(bull["verdictKey"] == .string("market.strongBuy"))
        #expect(bull["tone"] == .string("success"))
        #expect(bull["bullFraction"] == dec("0.6"))
        let bear = try compute(
            #"{"kind":"analyst","consensus":{"strongBuy":0,"buy":0,"hold":11,"sell":9,"strongSell":0}}"#)
        #expect(bear["verdictKey"] == .string("market.sell"))
        #expect(bear["bearFraction"] == dec("0.45"))
        #expect(
            try compute(#"{"kind":"analyst","consensus":{"strongBuy":0,"buy":0,"hold":0,"sell":0,"strongSell":0}}"#)
                == .null)
        #expect(try compute(#"{"kind":"analyst","consensus":null}"#) == .null)
        let consistent = try compute(#"{"kind":"marketAdd","amount":100,"units":3,"price":33.33}"#)
        #expect(consistent["isConsistent"] == .bool(true))
        let derived = try compute(#"{"kind":"marketAdd","amount":100,"units":3}"#)
        #expect(derived["derivedPrice"] == dec("33.333333"))
        #expect(derived["effectivePrice"] == dec("33.333333"))
        #expect(derived["isConsistent"] == .bool(true))
    }
    @Test func watchlistBatchRepeatsTheListConvention() throws {
        let batch = try compute(
            #"{"kind":"watchlistBatch","entries":[{"id":7,"targetPrice":10,"currentPrice":8,"addedPrice":4},{"id":9,"targetPrice":10,"currentPrice":null,"addedPrice":null}]}"#
        )
        let entries = try #require(batch["entries"]?.arrayValue)
        #expect(entries[0]["id"] == .number(7))
        #expect(entries[0]["list"]?["sinceAddedPercent"] == .number(100))
        #expect(
            entries[1]["list"]
                == .object([
                    "distancePercent": .null, "absoluteDistancePercent": .null, "isAtOrBelowTarget": .bool(false),
                    "sinceAddedPercent": .null,
                ]))
    }
    @Test func chartVolumeWithoutAVolumeLeavesTheKeyOutAndUnknownSourceYieldsNoOscillator() throws {
        let chart = try compute(
            #"{"kind":"chart","series":[{"id":"v","field":"volume","type":"bar","points":[{"time":1,"close":1,"volume":8},{"time":2,"close":1}]}],"indicators":[],"rebase":false,"oscillator":"rsi","oscillatorSeriesId":"missing"}"#
        )
        let rows = try #require(chart["rows"]?.arrayValue)
        #expect(rows[0] == .object(["time": .number(1), "v": .number(8)]))
        #expect(rows[1] == .object(["time": .number(2)]))
        #expect(chart["oscillatorRows"] == .array([]))
    }

    // MARK: input schema (Zod)

    @Test func malformedSnapshotsAreRejectedBeforeAnyArithmetic() throws {
        let rejects = [
            #"{"kind":"unknown"}"#, #"{"series":[]}"#,
            #"{"kind":"watchlist","targetPrice":10,"currentPrice":8}"#,
            #"{"kind":"watchlist","targetPrice":"10","currentPrice":8,"addedPrice":null}"#,
            #"{"kind":"compare","series":[{"symbol":"","points":[]}]}"#,
            #"{"kind":"compare","series":[{"symbol":"A","points":[{"time":"1"}]}]}"#,
            #"{"kind":"marketAdd","amount":0}"#, #"{"kind":"marketAdd","amount":null}"#,
            #"{"kind":"marketAdd","derive":"yes"}"#,
            #"{"kind":"watchlistBatch","entries":[{"id":0,"targetPrice":1,"currentPrice":null,"addedPrice":null}]}"#,
            #"{"kind":"chart","series":[{"id":"a","field":"price","type":"line","points":[]},{"id":"a","field":"price","type":"line","points":[]}],"indicators":[],"rebase":false,"oscillator":"none","oscillatorSeriesId":null}"#,
            #"{"kind":"chart","series":[],"indicators":[{"id":"i","type":"sma","period":2,"seriesId":"x"}],"rebase":false,"oscillator":"none","oscillatorSeriesId":null}"#,
            #"{"kind":"chart","series":[{"id":"a","field":"price","type":"line","points":[]}],"indicators":[{"id":"i","type":"sma","period":501,"seriesId":"a"}],"rebase":false,"oscillator":"none","oscillatorSeriesId":null}"#,
            #"{"kind":"chart","series":[{"id":"a","field":"price","type":"line","points":[]}],"indicators":[],"rebase":false,"oscillator":"none"}"#,
        ]
        for json in rejects { #expect(try rejected(json), Comment(rawValue: json)) }
        let seven = (0..<7).map { #"{"symbol":"S\#($0)","points":[]}"# }.joined(separator: ",")
        #expect(try rejected(#"{"kind":"compare","series":[\#(seven)]}"#))
    }

    // MARK: indicators.test.ts

    @Test func smaNullsTheWarmUpThenAveragesTheWindow() {
        #expect(ResearchMath.sma([1, 2, 3, 4, 5], 3) == [nil, nil, 2, 3, 4])
    }
    @Test func emaSeedsWithTheSmaAndIsNullBeforeThePeriod() throws {
        let out = ResearchMath.ema([1, 2, 3, 4, 5], 3)
        #expect(out[0] == nil && out[1] == nil)
        #expect(abs(try #require(out[2]) - 2) < 1e-6)
        #expect(abs(try #require(out[3]) - 3) < 1e-6)
        #expect(abs(try #require(out[4]) - 4) < 1e-6)
    }
    @Test func bollingerBandsStraddleTheMiddleBand() throws {
        let values = (0..<25).map { 100 + sin(Double($0)) }
        let bands = ResearchMath.bollinger(values, 20, 2)
        let middle = try #require(bands.middle[24])
        #expect(try #require(bands.upper[24]) > middle)
        #expect(try #require(bands.lower[24]) < middle)
    }
    @Test func rsiIs100ForAMonotonicallyRisingSeries() throws {
        let out = ResearchMath.rsi((1...16).map(Double.init), 14)
        #expect(abs(try #require(out[14]) - 100) < 1e-6)
    }
    @Test func rsiStaysWithinZeroToHundred() {
        let values = (0..<50).map { 50 + 10 * sin(Double($0) / 2) }
        for value in ResearchMath.rsi(values) {
            if let value { #expect(value >= 0 && value <= 100) }
        }
    }
    @Test func macdProducesAlignedArraysAndTheHistogramIsTheDifference() throws {
        let values = (0..<60).map { 100 + Double($0) + 5 * sin(Double($0) / 3) }
        let result = ResearchMath.macd(values)
        #expect(result.macd.count == 60 && result.signal.count == 60)
        let line = try #require(result.macd[59])
        let signal = try #require(result.signal[59])
        #expect(abs(try #require(result.histogram[59]) - (line - signal)) < 1e-6)
    }
    @Test func rebaseStartsTheFirstValidPointAt100() {
        #expect(ResearchMath.rebase([50, 75, 100]) == [100, 150, 200])
    }

    // MARK: portfolioUnitMath.test.ts (deriveUnitMath)

    @Test func derivesAmountFromUnitsTimesPrice() {
        let r = ResearchMath.deriveUnitMath(amount: nil, units: 3, price: 10)
        #expect(r.derivedAmount == 30 && r.effectiveAmount == 30 && r.isConsistent && r.providedCount == 2)
    }
    @Test func derivesUnitsFromAmountOverPrice() {
        let r = ResearchMath.deriveUnitMath(amount: 30, units: nil, price: 10)
        #expect(r.derivedUnits == 3 && r.effectiveUnits == 3 && r.isConsistent)
    }
    @Test func derivesPriceFromAmountOverUnits() {
        let r = ResearchMath.deriveUnitMath(amount: 30, units: 3, price: nil)
        #expect(r.derivedPrice == 10 && r.effectivePrice == 10 && r.isConsistent)
    }
    @Test func flagsInconsistentWhenAllThreeAreProvidedButAmountDiffers() {
        let r = ResearchMath.deriveUnitMath(amount: 999, units: 3, price: 10)
        #expect(r.providedCount == 3 && r.derivedAmount == nil && !r.isConsistent)
    }
    @Test func acceptsAllThreeWhenConsistentWithinTolerance() {
        #expect(ResearchMath.deriveUnitMath(amount: 30.00005, units: 3, price: 10).isConsistent)
    }
    @Test func acceptsTheExactlyOneCentBrokerStatementCase() {
        // 3 x 33.33 = 99.99 against a statement amount of 100.00.
        #expect(ResearchMath.deriveUnitMath(amount: 100.0, units: 3, price: 33.33).isConsistent)
    }
    @Test func stillRejectsADifferenceBeyondTheBackendTolerance() {
        #expect(!ResearchMath.deriveUnitMath(amount: 100.02, units: 3, price: 33.33).isConsistent)
    }
    @Test func isNotConsistentWithFewerThanTwoValues() {
        #expect(!ResearchMath.deriveUnitMath(amount: 30, units: nil, price: nil).isConsistent)
        #expect(!ResearchMath.deriveUnitMath(amount: nil, units: nil, price: nil).isConsistent)
    }
    @Test func roundsDerivedValuesToTheConfiguredPrecisions() {
        #expect(
            ResearchMath.deriveUnitMath(amount: 1, units: 3, price: nil).derivedPrice
                == ResearchMath.roundUnitMath(1.0 / 3, ResearchMath.unitMathPriceDP))
        #expect(
            ResearchMath.deriveUnitMath(amount: 1, units: nil, price: 3).derivedUnits
                == ResearchMath.roundUnitMath(1.0 / 3, ResearchMath.unitMathUnitsDP))
        #expect(
            ResearchMath.deriveUnitMath(amount: nil, units: 1.0 / 3, price: 3).derivedAmount
                == ResearchMath.roundUnitMath((1.0 / 3) * 3, ResearchMath.unitMathAmountDP))
    }
    @Test func doesNotDeriveOrValidateWhenDeriveIsFalse() throws {
        let r = ResearchMath.deriveUnitMath(amount: nil, units: 3, price: 10, derive: false)
        #expect(r.derivedAmount == nil && r.effectiveAmount == nil)
        #expect(r.effectiveUnits == 3 && r.effectivePrice == 10 && !r.isConsistent)
        let wire = try compute(#"{"kind":"marketAdd","units":3,"price":10,"derive":false}"#)
        #expect(
            wire
                == .object([
                    "providedCount": .number(2), "isConsistent": .bool(false), "effectiveUnits": .number(3),
                    "effectivePrice": .number(10),
                ]))
    }

    // MARK: JavaScript number semantics the port relies on

    @Test func mathRoundRoundsHalvesTowardPositiveInfinity() {
        #expect(ResearchMath.jsRound(2.5) == 3)
        #expect(ResearchMath.jsRound(-2.5) == -2)
        #expect(ResearchMath.jsRound(-0.5) == 0)
        #expect(ResearchMath.jsRound(0.49999999999999994) == 0)
        #expect(ResearchMath.jsRound(-1.4) == -1)
    }
    @Test func numbersPrintTheWayJSONStringifyPrintsThem() {
        let cases: [(Double, String)] = [
            (1e21, "1e+21"), (1e-7, "1e-7"), (123_456_789_012_345_680_000, "123456789012345680000"),
            (0.000001, "0.000001"), (100, "100"), (1.5, "1.5"), (-0.0, "0"), (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"), (0.1 + 0.2, "0.30000000000000004"),
            (-12.3, "-12.3"), (1234567890123456.8, "1234567890123456.8"), (83.33333333333334, "83.33333333333334"),
        ]
        for (value, text) in cases { #expect(JSNumber.string(value) == text, Comment(rawValue: text)) }
    }
}
