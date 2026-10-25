import CryptoKit
import Foundation
import Testing

@testable import VisionNativeCore

private func json(_ text: String) throws -> InterchangeJSON { try InterchangeJSON.parse(text) }
/// `{...base, key: value}`: an existing key keeps its position, a new key is appended.
private func merged(_ base: InterchangeJSON, _ pairs: [(String, InterchangeJSON)]) -> InterchangeJSON {
    var members = base.members ?? []
    for (key, value) in pairs {
        if let index = members.firstIndex(where: { $0.key == key }) {
            members[index].value = value
        } else {
            members.append(.init(key: key, value: value))
        }
    }
    return .object(members)
}
private func text(_ bytes: [UInt8]) -> String { String(decoding: bytes, as: UTF8.self) }
private func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
/// A one-entry stored ZIP holding `xl/worksheets/sheet1.xml`, as the TypeScript route tests build it.
private func storedSheet(_ source: String, method: Int = 0) -> [UInt8] {
    let name = Array("xl/worksheets/sheet1.xml".utf8)
    let bytes = Array(source.utf8)
    var header = [UInt8](repeating: 0, count: 30 + name.count)
    func put(_ offset: Int, _ value: UInt32, width: Int) {
        for index in 0..<width { header[offset + index] = UInt8((value >> UInt32(8 * index)) & 0xFF) }
    }
    put(0, 0x0403_4B50, width: 4)
    put(8, UInt32(method), width: 2)
    put(14, InterchangeCRC32.checksum(bytes), width: 4)
    put(18, UInt32(bytes.count), width: 4)
    put(26, UInt32(name.count), width: 2)
    header.replaceSubrange(30..<30 + name.count, with: name)
    return header + bytes
}

private let workbookFixture = #"""
{"requestId":"run","completedAt":"2026-09-30T10:00:00Z","columns":[{"id":"date","type":"date"},{"id":"amount","type":"decimal"},{"id":"precise","type":"decimal"},{"id":"note","type":"string"},{"id":"active","type":"boolean"}],"rows":[{"date":"2026-09-30","amount":"-12.30","precise":"1234567890123456.78","note":"=HYPERLINK(\"x\") & <tag>","active":true},{"date":null,"amount":null,"precise":null,"note":null,"active":null}],"window":{"kind":"page","offset":0,"hasMore":false,"limit":500,"returnedRows":2}}
"""#
private let routeResult = #"""
{"requestId":"fixture-captured","startedAt":"2026-10-13T10:00:00Z","completedAt":"2026-10-13T10:00:01Z","executor":"postgresql-role-v1","columns":[{"id":"date","type":"date"},{"id":"amount","type":"decimal"},{"id":"identifier","type":"string"},{"id":"note","type":"string"}],"rows":[{"date":"1900-01-01","amount":"-12.30","identifier":"9007199254740993","note":"=SUM(A1) & <tag>"}],"formulaSummaries":{"exact":"1234567890123456.78"},"coverage":{"complete":false,"status":"partial","unavailableRows":1},"transformationErrors":[{"message":"source missing"}],"window":{"kind":"page","offset":0,"limit":500,"returnedRows":1,"hasMore":false}}
"""#
private let routeContext = #"""
{"name":"Synthetic","timezone":"UTC","workspace":"budgeting","assumptions":{"definitions":[{"id":"rate","defaultValue":"0.1"}],"values":{"rate":"0.25"}},"formulas":[{"id":"sum","expression":"amount + 1"}]}
"""#

/// Ports of apps/frontend/src/features/analysis/{analysisInterchange,analysisWorkbook}.test.ts and of
/// apps/node-backend/tests/routes/analysisInterchange.test.ts (removed with the route), with the
/// same fixtures and expected values. Object key order is preserved by `InterchangeJSON.parse`, so the
/// workbook bytes are the ones the TypeScript produces for the same input.
@Suite("Analysis interchange port")
struct AnalysisInterchangeTests {
    // MARK: analysisInterchange.test.ts

    @Test func typedAndUnsafeIdentifierGoldenInputsKeepExactValuesAndHashes() throws {
        let typed = try AnalysisInterchange.parseScenarioCSV(
            text: "Plan,Cost,Enabled\nA,40.500,true\nB,,false\n", fileName: "golden.csv", size: 41,
            importedAt: "2026-10-13T00:00:00.000Z")
        #expect(
            typed
                == .object([
                    "id": .string("scenario_fe93d48dd4d5"), "fileName": .string("golden.csv"),
                    "importedAt": .string("2026-10-13T00:00:00.000Z"),
                    "sha256": .string("fe93d48dd4d5e4d3edfa57134d1bedaaa724819f166c15dcf713ad252289ab6a"),
                    "columns": .array([
                        .object(["id": .string("plan"), "label": .string("Plan"), "type": .string("string")]),
                        .object(["id": .string("cost"), "label": .string("Cost"), "type": .string("decimal")]),
                        .object(["id": .string("enabled"), "label": .string("Enabled"), "type": .string("boolean")]),
                    ]),
                    "rows": .array([
                        .object(["plan": .string("A"), "cost": .string("40.500"), "enabled": .bool(true)]),
                        .object(["plan": .string("B"), "cost": .null, "enabled": .bool(false)]),
                    ]),
                ]))
        let unsafe = try AnalysisInterchange.parseScenarioCSV(
            text: "Account,Date\n9007199254740993,2026-10-13\n", fileName: "golden.csv", size: 41,
            importedAt: "2026-10-13T00:00:00.000Z")
        #expect(unsafe["sha256"] == .string("f1df0ed4373217e98a9b307113c991fbf743552bf48427f25b02e419ef2e1f9d"))
        #expect(
            unsafe["columns"]
                == .array([
                    .object(["id": .string("account"), "label": .string("Account"), "type": .string("string")]),
                    .object(["id": .string("date"), "label": .string("Date"), "type": .string("date")]),
                ]))
        #expect(
            unsafe["rows"] == .array([.object(["account": .string("9007199254740993"), "date": .string("2026-10-13")])]))
    }
    @Test func exportsReproducibilityMetadataAndNeutralizesFormulaPayloads() throws {
        let result = try json(
            #"{"requestId":"analysis-test","startedAt":"2026-09-14T09:59:59Z","completedAt":"2026-09-14T10:00:00Z","executor":"postgresql-role-v1","rows":[{"label":"=CMD()","amount":"-12.34","scenario.rate":"+10%"}],"columns":[{"id":"label","type":"string"},{"id":"amount","type":"decimal"}],"generatedSql":"redacted","byteLength":10,"window":{"kind":"truncated","returnedRows":1,"enforcedLimit":1,"reason":"byte-limit"}}"#
        )
        let csv = AnalysisInterchange.analysisResultCSV(
            result,
            metadata: .init(
                name: "Scenario", timezone: "Europe/Helsinki", workspace: "budgeting", definitionId: "analysis:test",
                definitionVersion: 2, datasetIds: ["cash-flows"], sourceReferences: ["Synthetic Demo ledger"]))
        for expected in [
            "# definition_id,analysis:test", "# definition_version,2", "# request_id,analysis-test",
            "# datasets,cash-flows", "# source_references,Synthetic Demo ledger", "label:string:unit-unavailable",
            "scenario.rate:string:unit-unavailable:runtime-inferred", "# source_versions,unavailable",
            "# result_window,truncated:byte-limit", "'=CMD(),-12.34", "scenario.rate", "'+10%",
        ] { #expect(csv.contains(expected), Comment(rawValue: expected)) }
        #expect(!csv.contains("redacted"))
        #expect(!csv.contains("reporting_currency"))
        #expect(csv.hasSuffix("\r\n") && csv.hasPrefix("# Vision analysis export,Scenario\r\n"))
    }
    @Test func parsesTypedValueOnlyCSVAndHashesItsExactSource() throws {
        let attachment = try AnalysisInterchange.parseScenarioCSV(
            text: "Plan,Cost,Enabled\nA,40.5,true\n", fileName: "options.csv", size: 31, importedAt: "now")
        let columns = try #require(attachment["columns"]?.arrayValue)
        #expect(columns.map { $0["type"] } == [.string("string"), .string("decimal"), .string("boolean")])
        #expect(
            attachment["rows"]?.arrayValue?[0]
                == .object(["plan": .string("A"), "cost": .string("40.5"), "enabled": .bool(true)]))
        #expect(attachment["sha256"] == .string("0a8190490fb9b8c52dd10955a2636c8753dc1e88dbaf23eea0987fe51974c057"))
        #expect(attachment["sha256"]?.stringValue?.count == 64)
    }
    @Test func preservesUnsafeIntegerTextInsteadOfRoundingIt() throws {
        let attachment = try AnalysisInterchange.parseScenarioCSV(
            text: "Account\n9007199254740993\n", fileName: "ids.csv", size: 25, importedAt: "now")
        #expect(attachment["columns"]?.arrayValue?[0]["type"] == .string("string"))
        #expect(attachment["rows"]?.arrayValue?[0]["account"] == .string("9007199254740993"))
        #expect(attachment["sha256"] == .string("fde9527093b6c4c6c54f2cef84fb830146982720766b5b7523a4fd8aa8705dd9"))
    }

    // MARK: analysisInterchange route tests (CSV)

    @Test func csvImportReturnsExactTypedValuesAndStableReplacementIdentity() throws {
        let source = "Name,Cost,Account,Enabled,Date\nPlan,40.500,9007199254740993,true,2026-10-13\n"
        let file = AnalysisInterchangeFile(name: "scenario.csv", data: Data(source.utf8))
        let first = try AnalysisInterchange.importAttachment(file: file, format: "csv")
        let hash = "f10f63cd0384240e9e64d951ec3627ae2fb6046878554966bd31e3fab6e191fe"
        #expect(first.id == "scenario_" + hash.prefix(12))
        #expect(first.sha256 == hash)
        #expect(
            first.rows[0] == [
                "name": .string("Plan"), "cost": .string("40.500"), "account": .string("9007199254740993"),
                "enabled": .bool(true), "date": .string("2026-10-13"),
            ])
        #expect(first.columns[2].raw == .object(["id": .string("account"), "label": .string("Account"), "type": .string("string")]))
        let repeated = try AnalysisInterchange.importAttachment(
            file: .init(name: "renamed.csv", data: Data(source.utf8)), format: "csv")
        #expect(repeated.id == first.id)
        #expect(repeated.fileName == "renamed.csv")
    }
    @Test func csvDigestKeepsFileTextByteOrderMarkAndReplacementSemantics() throws {
        let bytes = Data([0xEF, 0xBB, 0xBF, 0x41, 0x0A, 0xFF, 0x0A])
        let attachment = try AnalysisInterchange.importAttachment(file: .init(name: "encoded.csv", data: bytes), format: "csv")
        #expect(attachment.sha256 == "f87a4d2daf065cc9866582082370ff3b84c3836553acc7c7c4699ff3ab154d7b")
        #expect(attachment.rows[0] == ["a": .string("\u{FFFD}")])
        #expect(interchangeDecodeUTF8([0xEF, 0xBB, 0xBF, 0x41]) == "A")
    }
    @Test func csvRejectsDuplicateColumnsWidthHeaderOnlyAndBounds() throws {
        let wide = (0..<33).map { "A\($0)" }.joined(separator: ",") + "\n" + Array(repeating: "1", count: 33).joined(separator: ",")
        let cases: [(String, String)] = [
            ("duplicate normalized columns", "A!,A?\n1,2\n"), ("bad row width", "A,B\n1\n"), ("header only", "A\n"),
            ("column cap", wide), ("row cap", "A\n" + String(repeating: "1\n", count: 1001)),
        ]
        for (label, source) in cases {
            #expect(throws: AnalysisInterchangeError.self, Comment(rawValue: label)) {
                try AnalysisInterchange.importAttachment(file: .init(name: "s.csv", data: Data(source.utf8)), format: "csv")
            }
        }
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.importAttachment(file: .init(name: "l.csv", data: Data(count: 1_000_001)), format: "csv")
        }
        let atLimit = try AnalysisInterchange.importAttachment(
            file: .init(name: "ok.csv", data: Data(("A\n" + String(repeating: "1\n", count: 1000)).utf8)), format: "csv")
        #expect(atLimit.rows.count == 1000)
    }
    @Test func csvReaderFollowsCsvParseQuotingAndLineRules() throws {
        #expect(
            try ScenarioCSVReader.parse("a,b\r\n\"x,1\",\"y\"\"z\"\r\n\r\n") == [["a", "b"], ["x,1", "y\"z"]])
        #expect(try ScenarioCSVReader.parse("a\n\"l1\nl2\"\n") == [["a"], ["l1\nl2"]])
        #expect(try ScenarioCSVReader.parse("a\n\nb\n") == [["a"], ["b"]])
        #expect(try ScenarioCSVReader.parse("a,b\n1,2") == [["a", "b"], ["1", "2"]])
        #expect(try ScenarioCSVReader.parse("a,b\n1,\n") == [["a", "b"], ["1", ""]])
        #expect(try ScenarioCSVReader.parse("a,b\r1,2\r") == [["a", "b"], ["1", "2"]])
        for broken in ["a\n\"b", "a\nb\"c\n", "a\n\"b\"c\n", "a,b\n1,2,3\n"] {
            #expect(throws: AnalysisInterchangeError.self, Comment(rawValue: broken)) { try ScenarioCSVReader.parse(broken) }
        }
    }
    @Test func columnIdentifiersNormalizeLikeTheTypeScript() {
        let labels = ["Plan Name!", " Cost (EUR) ", "123abc", "", "\u{00DC}n\u{00EF}", String(repeating: "a", count: 70)]
        let ids = labels.enumerated().map { AnalysisInterchange.columnID($1, index: $0) }
        #expect(ids == ["plan_name", "cost_eur", "column_3", "column_4", "n", String(repeating: "a", count: 64)])
    }
    @Test func csvEscapingMatchesEscapeCsvValue() {
        let cases: [(InterchangeJSON?, String)] = [
            (.string("-12.34"), "-12.34"), (.string("=1+1"), "'=1+1"), (.string("a,b"), "\"a,b\""),
            (.string("\t=x"), "'\t=x"), (.string("  =x"), "'  =x"), (.number(5), "5"), (.number(-1e-7), "-1e-7"),
            (.array([.number(1), .string("x"), .null]), "\"1,x,\""), (.null, ""), (nil, ""), (.string("say \"hi\""), "\"say \"\"hi\"\"\""),
            (.bool(false), "false"), (.string("@x"), "'@x"), (.string("12.5e3"), "12.5e3"),
        ]
        for (value, expected) in cases {
            #expect(AnalysisInterchange.escapeCSVValue(value) == expected, Comment(rawValue: expected))
        }
    }

    // MARK: analysisWorkbook.test.ts

    @Test func exportsSummaryOutcomesWithoutCollidingWithTheStylesRelationship() throws {
        let result = merged(
            try json(workbookFixture),
            [("formulaSummaries", try json(#"{"total":"123.45","unavailable":null,"exact":"1234567890123456.78"}"#))])
        let bytes = try AnalysisWorkbook.exportWorkbook(
            result: result, context: try json(#"{"name":"Summary","workspace":"budgeting","timezone":"UTC"}"#))
        let xml = text(bytes)
        #expect(xml.contains("name=\"Summary results\""))
        #expect(xml.contains("<c r=\"B2\"><v>123.45</v></c>"))
        #expect(
            xml.contains(
                "<c r=\"B4\" t=\"inlineStr\"><is><t xml:space=\"preserve\">1234567890123456.78</t></is></c>"))
        #expect(
            xml.contains(
                "Id=\"rId6\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\""))
    }
    @Test func buildsAStoredZipWorkbookAndRoundTripsCalendarDatesAndExactLongDecimals() throws {
        let context = try json(
            #"{"name":"Test","workspace":"budgeting","timezone":"Europe/Helsinki","assumptions":{"rate":"0.1"},"formulas":[{"expression":"amount * rate"}]}"#
        )
        let bytes = try AnalysisWorkbook.exportWorkbook(result: try json(workbookFixture), context: context)
        #expect(Array(bytes.prefix(4)) == [0x50, 0x4B, 0x03, 0x04])
        let xml = text(bytes)
        #expect(xml.contains("name=\"Formula definitions\""))
        #expect(xml.contains("15 significant digits"))
        #expect(!xml.contains("<f>"))
        #expect(xml.contains("&amp; &lt;tag&gt;"))
        let imported = try AnalysisWorkbook.importWorkbook(bytes)
        #expect(
            imported.rows[0] == [
                "date": .string("2026-09-30"), "amount": .number(-12.3), "precise": .string("1234567890123456.78"),
                "note": .string(#"=HYPERLINK("x") & <tag>"#), "active": .bool(true),
            ])
        #expect(imported.rows[1]["amount"] == WorkbookCell.null)
        #expect(imported.formulaCells == 0)
        #expect(imported.columns == ["date", "amount", "precise", "note", "active"])
    }
    @Test func rejectsOversizedOrMalformedImport() {
        do {
            _ = try AnalysisWorkbook.importWorkbook([UInt8](repeating: 0, count: 10_000_001))
            Issue.record("expected the 10 MB limit")
        } catch let error as AnalysisInterchangeError {
            #expect(error.message.contains("10 MB"))
        } catch { Issue.record(error) }
        do {
            _ = try AnalysisWorkbook.importWorkbook([UInt8](repeating: 0, count: 20))
            Issue.record("expected a missing Results sheet")
        } catch let error as AnalysisInterchangeError {
            #expect(error.message.contains("missing"))
        } catch { Issue.record(error) }
    }
    @Test func handlesExcels1900LeapYearCompatibilityAndTypedAssumptions() throws {
        let result = merged(
            try json(workbookFixture),
            [("rows", try json(#"[{"date":"1900-01-01","amount":"1"},{"date":"1900-03-01","amount":"2"}]"#))])
        let bytes = try AnalysisWorkbook.exportWorkbook(
            result: result,
            context: try json(
                #"{"name":"Historic","timezone":"UTC","workspace":"research","assumptions":{"definitions":[{"id":"rate","label":"Rate","defaultValue":"0.1"}],"values":{"rate":"0.25"}}}"#
            ))
        let xml = text(bytes)
        #expect(xml.contains("<c r=\"A2\" s=\"1\"><v>1</v></c>"))
        #expect(xml.contains("<c r=\"A3\" s=\"1\"><v>61</v></c>"))
        #expect(xml.contains("<c r=\"C2\"><v>0.25</v></c>"))
        #expect(
            try AnalysisWorkbook.importWorkbook(bytes).rows.map { $0["date"] }
                == [.string("1900-01-01"), .string("1900-03-01")])
    }
    @Test func restoresStableSourceIdentifiersRatherThanUserFacingHeaderLabels() throws {
        let result = merged(
            try json(workbookFixture),
            [
                ("declaredColumns", try json(#"[{"id":"flow","label":"Net cash flow","type":"decimal","nullable":true}]"#)),
                ("rows", try json(#"[{"flow":"12.30"}]"#)),
            ])
        let bytes = try AnalysisWorkbook.exportWorkbook(
            result: result, context: try json(#"{"name":"Label","timezone":"UTC","workspace":"budgeting"}"#))
        #expect(text(bytes).contains("Net cash flow"))
        let imported = try AnalysisWorkbook.importWorkbook(bytes)
        #expect(imported.columns == ["flow"])
        #expect(imported.rows[0] == ["flow": .number(12.3)])
    }
    @Test func exportsValueCompletenessAndErrorLineageIndependentlyOfRowPagination() throws {
        let result = merged(
            try json(workbookFixture),
            [
                ("complete", .bool(false)),
                (
                    "coverage",
                    try json(#"{"complete":false,"status":"partial","unavailableRows":1,"sourceRows":2}"#)
                ),
                ("transformationCoverage", try json(#"[{"complete":false,"operation":"convert"}]"#)),
                ("preparationLineage", try json(#"[{"step":"date conversion"}]"#)),
                ("transformationErrors", try json(#"[{"message":"Invalid date"}]"#)),
                (
                    "formulaErrors",
                    try json(#"[{"formulaId":"total","code":"INCOMPLETE","message":"Unavailable contributor"}]"#)
                ),
            ])
        let bytes = try AnalysisWorkbook.exportWorkbook(
            result: result, context: try json(#"{"name":"Partial","workspace":"research","timezone":"UTC"}"#))
        let xml = text(bytes)
        for key in [
            "complete", "financialCoverage", "transformationCoverage", "preparationLineage", "transformationErrors",
            "formulaErrors", "Invalid date", "Unavailable contributor", "unavailableRows",
        ] { #expect(xml.contains(key), Comment(rawValue: key)) }
        #expect(xml.contains("&quot;status&quot;:&quot;partial&quot;"))
        #expect(xml.contains("&quot;kind&quot;:&quot;page&quot;"))
        #expect(try AnalysisWorkbook.importWorkbook(bytes).rows.count == 2)
    }

    // MARK: analysisInterchange route tests (workbook)

    @Test func importsWorkbookProvenanceIdentifiersExactLongDecimalsCalendarDatesAndFreshAppendIdentity() throws {
        let columns = try #require(try json(routeResult)["columns"]?.arrayValue)
        let declared = InterchangeJSON.array(
            columns.map { column in
                merged(
                    column,
                    [
                        ("label", .string("Display " + (column["id"]?.stringValue ?? ""))),
                        ("unit", try! json(#"{"kind":"money","currency":"EUR"}"#)),
                    ])
            })
        let snapshot = merged(try json(routeResult), [("declaredColumns", declared)])
        let bytes = try AnalysisWorkbook.exportWorkbook(result: snapshot, context: try json(routeContext))
        let first = try AnalysisInterchange.importAttachment(
            file: .init(name: "snapshot.xlsx", data: Data(bytes)), format: "xlsx")
        #expect(
            first.rows[0] == [
                "date": .string("1900-01-01"), "amount": .number(Decimal(string: "-12.3")!),
                "identifier": .string("9007199254740993"), "note": .string("=SUM(A1) & <tag>"),
            ])
        #expect(first.columns[1].raw == .object(["id": .string("amount"), "label": .string("amount"), "type": .string("decimal")]))
        #expect(first.sha256 == sha256Hex(Data(bytes)))
        #expect(first.id.hasPrefix("workbook_") && first.id.count == "workbook_".count + 32)
        let repeated = try AnalysisInterchange.importAttachment(
            file: .init(name: "snapshot.xlsx", data: Data(bytes)), format: "xlsx")
        #expect(repeated.id != first.id)
        let fixed = try AnalysisInterchange.importAttachment(
            file: .init(name: "snapshot.xlsx", data: Data(bytes)), format: "xlsx", makeWorkbookID: { "workbook_fixed" })
        #expect(fixed.id == "workbook_fixed")
    }
    @Test func countsIgnoredFormulaCellsWithoutEvaluatingCachedResults() throws {
        let bytes = storedSheet(
            "<worksheet><sheetData><row><c t=\"inlineStr\"><is><t>value</t></is></c></row><row><c><f>1+1</f><v>2</v></c></row></sheetData></worksheet>"
        )
        let imported = try AnalysisWorkbook.importWorkbook(bytes)
        #expect(imported.formulaCells == 1)
        #expect(imported.rows[0] == ["value": .null])
    }
    @Test func exportIsDeterministicAndPreservesAbsenceOfOptionalContextMetadata() throws {
        let result = try json(routeResult)
        let context = try json(routeContext)
        let first = try AnalysisWorkbook.exportWorkbook(result: result, context: context)
        #expect(first == (try AnalysisWorkbook.exportWorkbook(result: result, context: context)))
        let xml = text(first)
        for value in ["financialCoverage", "source missing", "1234567890123456.78", "Formula definitions", "0.25"] {
            #expect(xml.contains(value), Comment(rawValue: value))
        }
        #expect(!xml.contains("<f>"))
        #expect(!xml.contains("definitionId"))
    }
    @Test func exportsTheExactCSVFormulaProtectionAndReproducibilityMetadata() throws {
        let metadata = AnalysisInterchange.CSVMetadata(
            name: "Synthetic", timezone: "UTC", workspace: "budgeting", datasetIds: ["cash-flows"],
            sourceReferences: ["Synthetic Demo"])
        let csv = AnalysisInterchange.analysisResultCSV(try json(routeResult), metadata: metadata)
        #expect(csv.contains("'=SUM(A1)"))
        #expect(csv.contains("# definition_id,unavailable\r\n"))
        #expect(csv.contains("# definition_version,unavailable\r\n"))
        #expect(csv.contains("# source_date_columns,date\r\n"))
        #expect(csv.contains("# result_window,complete\r\n"))
        #expect(csv.contains("date,amount,identifier,note\r\n"))
        #expect(csv.contains("1900-01-01,-12.30,9007199254740993,'=SUM(A1) & <tag>\r\n"))
    }
    @Test func preservesCapturedJSONAndArrayCellsAndCurrencyInBothExports() throws {
        let captured = merged(
            try json(routeResult),
            [
                (
                    "columns",
                    try json(
                        #"[{"id":"currency","type":"string"},{"id":"category_path_ids","type":"array"},{"id":"details","type":"json"},{"id":"amount","type":"decimal"}]"#
                    )
                ),
                (
                    "rows",
                    try json(
                        #"[{"currency":"USD","category_path_ids":[1,"9007199254740993",null],"details":{"note":"=1+1","unavailable":null,"enabled":false},"amount":"-12.3000"}]"#
                    )
                ),
            ])
        let context = try json(#"{"name":"Synthetic","timezone":"UTC","workspace":"budgeting"}"#)
        let csv = AnalysisInterchange.analysisResultCSV(
            captured,
            metadata: .init(name: "Synthetic", timezone: "UTC", workspace: "budgeting", datasetIds: [], sourceReferences: []))
        #expect(csv.contains("USD") && csv.contains("-12.3000"))
        let imported = try AnalysisWorkbook.importWorkbook(try AnalysisWorkbook.exportWorkbook(result: captured, context: context))
        #expect(imported.rows[0]["currency"] == .string("USD"))
        #expect(imported.rows[0]["category_path_ids"] == .string(#"[1,"9007199254740993",null]"#))
        #expect(imported.rows[0]["details"] == .string(#"{"note":"=1+1","unavailable":null,"enabled":false}"#))
    }
    @Test func supportsHundredThousandRowExportsWithoutTruncationAndRejectsMore() throws {
        func rows(_ count: Int) -> InterchangeJSON {
            merged(
                InterchangeJSON.ordered([
                    ("requestId", .string("big")), ("completedAt", .string("2026-10-13T10:00:01Z")),
                    ("columns", .array([.ordered([("id", .string("amount")), ("type", .string("decimal"))])])),
                    ("rows", .array([])),
                    (
                        "window",
                        .ordered([
                            ("kind", .string("page")), ("offset", .number(0)), ("limit", .number(500)),
                            ("returnedRows", .number(1)), ("hasMore", .bool(false)),
                        ])
                    ),
                ]),
                [("rows", .array(Array(repeating: .ordered([("amount", .string("12.30"))]), count: count)))])
        }
        let context = try json(routeContext)
        let xml = text(try AnalysisWorkbook.exportWorkbook(result: rows(100_000), context: context))
        #expect(xml.contains("<row r=\"100001\">"))
        #expect(!xml.contains("<row r=\"100002\">"))
        do {
            _ = try AnalysisWorkbook.exportWorkbook(result: rows(100_001), context: context)
            Issue.record("expected the 100,000 row limit")
        } catch let error as AnalysisInterchangeError {
            #expect(error.message.contains("100,000"))
        }
    }
    @Test func retainsAttachmentRowAndColumnCapsAfterParsingASupportedWorkbook() throws {
        let context = try json(routeContext)
        let rows = merged(
            try json(routeResult),
            [
                ("columns", try json(#"[{"id":"amount","type":"string"}]"#)),
                ("rows", .array(Array(repeating: try json(#"{"amount":"1"}"#), count: 1001))),
            ])
        let columnIDs = (0..<33).map { "c\($0)" }
        let columns = merged(
            try json(routeResult),
            [
                ("columns", .array(columnIDs.map { .ordered([("id", .string($0)), ("type", .string("string"))]) })),
                ("rows", .array([.ordered([("c0", .string("x"))])])),
            ])
        for snapshot in [rows, columns] {
            let bytes = try AnalysisWorkbook.exportWorkbook(result: snapshot, context: context)
            do {
                _ = try AnalysisInterchange.importAttachment(file: .init(name: "b.xlsx", data: Data(bytes)), format: "xlsx")
                Issue.record("expected the attachment caps")
            } catch let error as AnalysisInterchangeError {
                #expect(error.message.contains("attachment"))
            }
        }
    }
    @Test func rejectsCompressedEntriesChecksumMismatchesAndMalformedXMLWithoutFormulaExecution() throws {
        let xml = "<worksheet><row><c t=\"inlineStr\"><is><t>A</t></is></c></row></worksheet>"
        var corrupt = storedSheet(xml)
        corrupt[corrupt.count - 1] = 32
        let cases: [(String, [UInt8])] = [
            ("compressed", storedSheet(xml, method: 8)), ("checksum", corrupt),
            ("malformed", storedSheet("<worksheet><row></worksheet>")),
        ]
        for (label, bytes) in cases {
            #expect(throws: AnalysisInterchangeError.self, Comment(rawValue: label)) {
                try AnalysisInterchange.importAttachment(file: .init(name: "i.xlsx", data: Data(bytes)), format: "xlsx")
            }
        }
        let valid = try AnalysisWorkbook.importWorkbook(storedSheet(xml))
        #expect(valid.columns == ["A"] && valid.rows.isEmpty)
    }
    @Test func rejectsInvalidSnapshotsAndFormats() throws {
        let context = try json(routeContext)
        let bad = merged(try json(routeResult), [("rows", try json("[[]]"))])
        #expect(throws: AnalysisInterchangeError.self) { try AnalysisInterchange.validateExport(result: bad, context: context) }
        let noWindow = InterchangeJSON.object((try json(routeResult).members ?? []).filter { $0.key != "window" })
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.validateExport(result: noWindow, context: context)
        }
        let badSummary = merged(try json(routeResult), [("formulaSummaries", try json(#"{"x":[1]}"#))])
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.validateExport(result: badSummary, context: context)
        }
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.validateExport(result: try json(routeResult), context: try json(#"{"name":"x"}"#))
        }
        try AnalysisInterchange.validateExport(result: try json(routeResult), context: context)
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.importAttachment(file: .init(name: "a.csv", data: Data("A\n1".utf8)), format: "ods")
        }
    }

    // MARK: Entry points

    @Test func exportFileNamesAndEncodesTheCapturedSnapshot() throws {
        let wire: TaxValue = .object([
            "requestId": .string("analysis-test"), "startedAt": .string("2026-09-14T09:59:59Z"),
            "completedAt": .string("2026-09-14T10:00:00Z"), "executor": .string("postgresql-role-v1"),
            "rows": .array([.object(["label": .string("=CMD()"), "amount": .string("-12.34")])]),
            "columns": .array([
                .object(["id": .string("label"), "type": .string("string")]),
                .object(["id": .string("amount"), "type": .string("decimal")]),
            ]),
            "window": .object([
                "kind": .string("page"), "offset": .number(0), "limit": .number(500), "returnedRows": .number(1),
                "hasMore": .bool(false),
            ]), "byteLength": .number(10), "generatedSql": .string("SELECT 1"),
        ])
        let result = try wire.decode(AnalysisResult.self)
        let context: TaxValue = .object([
            "name": .string("Household Plan!"), "timezone": .string("UTC"), "workspace": .string("budgeting"),
            "datasetIds": .array([.string("cash-flows")]), "sourceReferences": .array([]),
            "assumptions": .object(["definitions": .array([]), "values": .object([:])]), "formulas": .array([]),
        ])
        let csv = try AnalysisInterchange.exportFile(result: result, context: context, format: "csv")
        #expect(csv.filename == "household-plan-.csv")
        #expect(csv.contentType == "text/csv")
        let csvText = String(decoding: csv.data, as: UTF8.self)
        #expect(csvText.hasPrefix("# Vision analysis export,Household Plan!\r\n"))
        #expect(csvText.contains("'=CMD(),-12.34\r\n"))
        let xlsx = try AnalysisInterchange.exportFile(result: result, context: context, format: "xlsx")
        #expect(xlsx.filename == "Household Plan!.xlsx")
        #expect(xlsx.contentType == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        #expect(Array(xlsx.data.prefix(4)) == [0x50, 0x4B, 0x03, 0x04])
        #expect(try AnalysisWorkbook.importWorkbook(Array(xlsx.data)).rows[0]["label"] == .string("=CMD()"))
        #expect(throws: AnalysisInterchangeError.self) {
            try AnalysisInterchange.exportFile(result: result, context: context, format: "pdf")
        }
        let unnamed = try AnalysisInterchange.exportFile(
            result: result,
            context: .object(["name": .string(""), "timezone": .string("UTC"), "workspace": .string("budgeting")]),
            format: "csv")
        #expect(unnamed.filename == "analysis.csv")
    }

    // MARK: Support

    @Test func jsonKeepsKeyOrderDuplicateSemanticsAndJavaScriptNumberText() throws {
        let value = try json(#"{"b":1,"a":[true,null,"x\n\u0001"],"c":{"z":1.5e300},"b":2}"#)
        #expect(value.stringified() == #"{"b":2,"a":[true,null,"x\n\u0001"],"c":{"z":1.5e+300}}"#)
        #expect(throws: InterchangeJSON.ParseError.self) { try json("{") }
        #expect(throws: InterchangeJSON.ParseError.self) { try json("[1,]") }
        #expect(try json(#""😀""#) == .string("\u{1F600}"))
        #expect(InterchangeJSON.array([.array([.number(1), .null]), .string("x")]).jsString() == "1,,x")
        #expect(InterchangeJSON.object([]).jsString() == "[object Object]")
    }
    @Test func numberParsingFollowsJavaScriptNumber() {
        #expect(JSNumber.parse("0x10") == 16)
        #expect(JSNumber.parse("1e3") == 1000)
        #expect(JSNumber.parse(" 5 ") == 5)
        #expect(JSNumber.parse("") == 0)
        #expect(JSNumber.parse(".5") == 0.5)
        #expect(JSNumber.parse("5.") == 5)
        #expect(JSNumber.parse("-Infinity") == -.infinity)
        #expect(JSNumber.parse("abc").isNaN)
        #expect(JSNumber.parse("-0x10").isNaN)
        #expect(JSNumber.parse("1_0").isNaN)
    }
    @Test func calendarMatchesDateUTCSemantics() {
        #expect(InterchangeCalendar.realDate("2024-02-29") != nil)
        #expect(InterchangeCalendar.realDate("2023-02-29") == nil)
        #expect(InterchangeCalendar.realDate("1900-02-29") == nil)
        #expect(InterchangeCalendar.realDate("2000-02-29") != nil)
        #expect(InterchangeCalendar.realDate("0000-01-01") != nil)
        #expect(InterchangeCalendar.realDate("2026-1-01") == nil)
        #expect(InterchangeCalendar.isoDatePrefix(milliseconds: -2_209_161_600_000) == "1899-12-30")
        #expect(InterchangeCalendar.isoDatePrefix(milliseconds: .nan) == nil)
        #expect(InterchangeCalendar.daysFromCivil(year: 1970, month: 1, day: 1) == 0)
        let civil = InterchangeCalendar.civilFromDays(-25_569)
        #expect(civil.year == 1899 && civil.month == 12 && civil.day == 30)
    }
}
