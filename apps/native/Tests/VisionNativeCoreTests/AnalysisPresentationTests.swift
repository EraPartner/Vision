import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Analysis result presentation and interchange")
struct AnalysisPresentationTests {
    @Test func exactStringsRetainEveryDigitAndFractionAcrossFormats() {
        let value = TaxValue.string("-900719925474099312345678901234567890123456789.123456789000")
        #expect(
            AnalysisPresentation.format(value: value, type: "decimal", id: "total", numberFormat: "eu")
                == "-900.719.925.474.099.312.345.678.901.234.567.890.123.456.789,123456789000")
        #expect(
            AnalysisPresentation.format(
                value: .string("1234567.5600"), type: "decimal", id: "total", numberFormat: "in") == "12,34,567.5600")
        #expect(
            AnalysisPresentation.format(value: .string("1234.5600"), type: "decimal", id: "total", numberFormat: "ch")
                == "1’234.5600")
    }
    @Test func identifiersTextNullsAndZeroStayDistinct() {
        for type in ["integer", "decimal"] {
            #expect(
                AnalysisPresentation.format(value: .string("001234"), type: type, id: "account_id", numberFormat: "eu")
                    == "001234")
        }
        #expect(
            AnalysisPresentation.format(value: .string("001234"), type: "string", id: "reference", numberFormat: "eu")
                == "001234")
        #expect(AnalysisPresentation.format(value: .number(0), type: "integer", id: "count", numberFormat: "eu") == "0")
        #expect(AnalysisPresentation.format(value: .null, type: "decimal", id: "total", numberFormat: "eu") == "—")
        #expect(
            AnalysisPresentation.format(
                value: .string("1234.5600"), type: "decimal", id: "total", numberFormat: "eu", mode: .raw)
                == "1234.5600")
    }
    @Test func formattedValuesUseHalfEvenWithoutDecimalSizeLimit() {
        for (raw, expected) in [
            ("1.225", "1.22"), ("1.235", "1.24"), ("9.995", "10.00"), ("-0.001", "-0.00"), ("1", "1.00"),
        ] {
            #expect(
                AnalysisPresentation.format(
                    value: .string(raw), type: "decimal", id: "value", numberFormat: "us", mode: .formatted) == expected
            )
        }
        let raw = "999999999999999999999999999999999999999999999.995"
        #expect(
            AnalysisPresentation.format(
                value: .string(raw), type: "decimal", id: "value", numberFormat: "us", mode: .formatted)
                == "1,000,000,000,000,000,000,000,000,000,000,000,000,000,000,000.00")
    }
    @Test func completenessCombinesWindowFinancialAndTransformationMetadata() {
        let base: TaxValue = .object([
            "window": .object(["kind": .string("page"), "offset": .number(0), "hasMore": .bool(false)])
        ])
        #expect(AnalysisPresentation.isComplete(base))
        for (key, value) in [
            ("complete", TaxValue.bool(false)), ("coverage", .object(["status": .string("partial")])),
            ("coverage", .object(["complete": .bool(false)])),
            ("transformationCoverage", .array([.object(["complete": .bool(false)])])),
            ("transformationErrors", .array([.object(["message": .string("Invalid date")])])),
        ] {
            var incomplete = base
            incomplete[key] = value
            #expect(!AnalysisPresentation.isComplete(incomplete))
            #expect(incomplete["window"] == base["window"])
        }
        for window in [
            TaxValue.object(["kind": .string("truncated")]),
            .object(["kind": .string("page"), "offset": .number(500), "hasMore": .bool(false)]),
            .object(["kind": .string("page"), "offset": .number(0), "hasMore": .bool(true)]),
        ] {
            var partial = base
            partial["window"] = window
            #expect(!AnalysisPresentation.isComplete(partial))
        }
    }
    @Test func dimensionalScopeRequiresOneCurrencyAndOneInstrument() {
        var result: TaxValue = .object([
            "rows": .array([.object(["a": .string("1"), "b": .string("2"), "currency": .string("EUR")])]),
            "columns": .array([
                .object([
                    "id": .string("a"), "type": .string("decimal"),
                    "unit": .object(["kind": .string("money"), "currency": .string("EUR")]),
                ]),
                .object([
                    "id": .string("b"), "type": .string("decimal"),
                    "unit": .object(["kind": .string("money"), "currencyColumn": .string("currency")]),
                ]),
            ]),
        ])
        #expect(AnalysisPresentation.compatibleChartUnits(result: result, series: ["a", "b"]))
        result["rows"] = .array([.object(["a": .string("1"), "b": .string("2")])])
        #expect(!AnalysisPresentation.compatibleChartUnits(result: result, series: ["a", "b"]))
        result["columns"] = .array([
            .object([
                "id": .string("units"),
                "unit": .object(["kind": .string("quantity"), "instrumentColumn": .string("investment_id")]),
            ])
        ])
        #expect(!AnalysisPresentation.compatibleChartUnits(result: result, series: ["units"]))
        result["rows"] = .array([
            .object(["units": .string("1"), "investment_id": .number(1)]),
            .object(["units": .string("2"), "investment_id": .number(2)]),
        ])
        #expect(!AnalysisPresentation.compatibleChartUnits(result: result, series: ["units"]))
    }
    @Test func labelsTranslateCatalogMatchesAndPreserveCustomAliases() {
        let strings = DictionaryStrings(
            language: .nl,
            table: ["analysis.catalog.Spending": "Uitgaven", "analysis.catalog.Cash_flow_ID": "Kasstroom-ID"])
        #expect(AnalysisPresentation.catalogLabel("Cash-flow ID", strings: strings) == "Kasstroom-ID")
        let dataset: TaxValue = .object([
            "measures": .array([.object(["id": .string("sum"), "label": .string("Spending")])])
        ])
        var result: TaxValue = .object(["declaredColumns": .array([])])
        #expect(
            AnalysisPresentation.columnLabel(result: result, id: "sum", datasets: [dataset], strings: strings)
                == "Uitgaven")
        result["declaredColumns"] = .array([.object(["id": .string("sum"), "label": .string("My household spending")])])
        #expect(
            AnalysisPresentation.columnLabel(result: result, id: "sum", datasets: [dataset], strings: strings)
                == "My household spending")
    }
    @Test func attachmentsPreserveStringsIdentifiersNullsAndUnknownMetadata() throws {
        let raw = attachmentFixture()
        let attachment = try AnalysisAttachment(raw: raw)
        #expect(attachment.rows[0]["amount"] == .string("900719925474099312345678901234567890123456789.1200"))
        #expect(attachment.rows[0]["account_id"] == .string("001234"))
        #expect(attachment.rows[0]["missing"] == .null)
        #expect(try TaxValue(encoding: attachment) == raw)
    }
    @Test func importedAttachmentsRejectExcessRowsColumnsAndNonScalarCells() {
        for defect in ["rows", "columns", "cell"] {
            var raw = attachmentFixture()
            if defect == "rows" { raw["rows"] = .array(Array(repeating: .object([:]), count: 1001)) }
            if defect == "columns" {
                raw["columns"] = .array(
                    Array(
                        repeating: .object(["id": .string("x"), "label": .string("X"), "type": .string("string")]),
                        count: 33))
            }
            if defect == "cell" { raw["rows"] = .array([.object(["amount": .array([.number(1)])])]) }
            #expect(throws: APIError.self) { try AnalysisAttachment(raw: raw) }
        }
    }
    @Test func interchangeRunsLocallyAndEnforcesTheImportLimits() throws {
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.importAttachment(
                file: .init(name: "huge.csv", data: Data(count: 1_000_001)), format: "csv")
        }
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.importAttachment(
                file: .init(name: "huge.xlsx", data: Data(count: 10_000_001)), format: "xlsx")
        }
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.importAttachment(file: .init(name: "a.ods", data: Data()), format: "ods")
        }
        let attachment = try AnalysisInterchange.importAttachment(
            file: .init(name: "inputs.csv", data: Data("Month,Cost\nJan,40.5\n".utf8)), format: "csv",
            now: Date(timeIntervalSince1970: 1_800_000_000))
        #expect(attachment.columns.map(\.id) == ["month", "cost"])
        #expect(attachment.importedAt == "2027-01-15T08:00:00.000Z")
        #expect(attachment.rows[0]["cost"] == .string("40.5"))
    }
}
private func attachmentFixture() -> TaxValue {
    .object([
        "id": .string("scenario_0123456789ab"), "fileName": .string("inputs.csv"),
        "importedAt": .string("2026-10-13T00:00:00Z"),
        "sha256": .string(String(repeating: "a", count: 64)), "unknown": .string("retain"),
        "columns": .array([.object(["id": .string("amount"), "label": .string("Amount"), "type": .string("decimal")])]),
        "rows": .array([
            .object([
                "amount": .string("900719925474099312345678901234567890123456789.1200"),
                "account_id": .string("001234"), "missing": .null,
            ])
        ]),
    ])
}
