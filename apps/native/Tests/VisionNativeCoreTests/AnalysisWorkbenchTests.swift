import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Analysis workbench server boundary and stale response guards")
struct AnalysisWorkbenchTests {
    @Test func savedExtensionFieldsAndExactNumericTextSurviveStructuralEdits() {
        var draft = AnalysisWorkbenchDraft(
            formulas: [
                .object([
                    "id": .string("net"), "scope": .string("summary"), "unit": .string("money"),
                    "engineVersion": .number(3),
                ])
            ],
            assumptions: [
                .object([
                    "id": .string("rate"), "defaultValue": .string("0.000000000000000000123456789"),
                    "unknown": .bool(true),
                ])
            ],
            assumptionValues: ["rate": .null], config: .object(["customExtension": .object(["keep": .bool(true)])]))
        #expect(draft.resolvedAssumptions["rate"] == .string("0.000000000000000000123456789"))
        draft.setAssumptionValue(at: 0, text: "12345678901234567890.123456789")
        draft.setAssumptionUnit(at: 0, kind: "money")
        draft.copyScenario(name: "  Baseline  ", id: "scenario_1")
        let roundtrip = AnalysisWorkbenchDraft(
            formulasJson: draft.formulasJson, assumptionsJson: draft.assumptionsJson,
            assumptionValuesJson: draft.assumptionValuesJson, config: draft.config)
        #expect(roundtrip == draft)
        #expect(roundtrip.formulas[0]["engineVersion"] == .number(3))
        #expect(roundtrip.assumptions[0]["unknown"] == .bool(true))
        #expect(roundtrip.config["customExtension"]?["keep"] == .bool(true))
        #expect(roundtrip.assumptions[0]["unit"]?["currency"] == .string("EUR"))
        #expect(roundtrip.scenarios[0]["assumptions"]?["rate"] == .string("12345678901234567890.123456789"))
        draft.config["time"] = .null
        #expect(draft.time(defaultDateColumn: "booking_date")["dateColumn"] == .string("booking_date"))
        draft.assumptions[0]["unit"] = .object(["kind": .string("money"), "currency": .null])
        draft.setAssumptionUnit(at: 0, kind: "money")
        #expect(draft.assumptions[0]["unit"]?["currency"] == .string("EUR"))
    }

    @Test func preparationEmbedsTheSelectedImportedTableAndRejectsUnpivotNameCollisions() {
        var step = AnalysisPreparationStepDraft()
        step.type = "lookup"
        step.column = "recipient"
        step.inputId = "imported"
        step.inputKey = "name"
        let imported: TaxValue = .object([
            "rows": .array([.object(["name": .string("Example")])]),
            "columns": .array([.object(["id": .string("name"), "type": .string("string")])]),
        ])
        let wire = step.payload(input: imported, assumptions: [:])
        #expect(wire["input"] == imported)
        #expect(wire["keys"] == .array([.string("recipient")]))
        #expect(wire["inputKeys"] == .array([.string("name")]))
        step.type = "unpivot"
        step.selected = ["amount"]
        step.outputId = " label "
        step.unpivotValueColumn = " amount "
        #expect(!step.isValid(columnIds: ["amount"]))
        #expect(step.hasUnpivotConflict(columnIds: ["amount"]))
        step.unpivotValueColumn = "value"
        #expect(step.isValid(columnIds: ["amount"]))
        #expect(step.payload(input: nil, assumptions: [:])["nameColumn"] == .string("label"))
        #expect(
            AnalysisWorkbenchDraft.valuesList("0, 0.000000000000000000123456789, , 10")
                == .array([.string("0"), .string("0.000000000000000000123456789"), .string("10")]))
    }

    @Test func requestsCarryDeclaredUnitsCoverageAndCompleteSourceWithoutCalculatingValues() throws {
        let model = workbench()
        configure(model, result: try source())
        model.draft.formulas = [
            .object(["id": .string("forecast"), "scope": .string("summary"), "expression": .string("SUM(row.amount)")])
        ]
        model.draft.assumptions = [
            .object([
                "id": .string("rate"), "defaultValue": .string("0.125"),
                "unit": .object(["kind": .string("percentage"), "percentageBasis": .string("ratio")]),
            ])
        ]
        let request = model.request(operation: "formulas")
        #expect(request["columns"]?.arrayValue?.first?["unit"]?["currency"] == .string("EUR"))
        #expect(request["complete"] == .bool(true) && request["inputComplete"] == .bool(true))
        #expect(request["coverage"]?["complete"] == .bool(true))
        #expect(request["rows"]?.arrayValue?.first?["amount"] == .string("12345678901234567890.123456789"))
        #expect(request["assumptionUnits"]?["rate"]?["percentageBasis"] == .string("ratio"))
        model.cancel()
    }

    @Test func incompleteSourcesAllowRowPreparationButBlockCalendarAndScenarioTools() throws {
        let model = workbench()
        configure(model, result: try source(hasMore: true))
        model.draft.steps = [
            .object(["type": .string("convert"), "columnId": .string("amount"), "targetType": .string("decimal")])
        ]
        model.draft.formulas = [.object(["id": .string("total"), "scope": .string("summary")])]
        model.draft.assumptions = [.object(["id": .string("rate"), "defaultValue": .string("0")])]
        model.draft.copyScenario(name: "A", id: "a")
        model.updateTime("dateColumn", value: .string("date"))
        model.updateTime("valueColumns", value: .array([.string("amount")]))
        model.outcomeId = "total"
        model.variableId = "rate"
        #expect(model.canApplySteps && model.canApplyFormulas)
        #expect(!model.complete && !model.canApplyTime && !model.canCompare && !model.canExplore)
        configure(model, result: try source(), stale: true)
        #expect(!model.canApply && !model.previewBusy)
        model.cancel()
    }

    @Test func everyExplicitApplyUsesTheFullFormulaPipelineAndServerOutput() async throws {
        let transport = WorkbenchTransport()
        let model = workbench(transport: transport)
        configure(model, result: try source())
        var applied: AnalysisExtensionOutput?
        model.didApply = { applied = $0 }
        await model.run(operation: "time", fields: ["bucket": .string("year")], apply: true)
        let request = try #require(await transport.requests.first)
        #expect(request["operation"] == .string("formulas"))
        #expect(request["bucket"] == nil)
        #expect(model.error == nil)
        #expect(applied?.raw["summaries"]?["total"] == .string("server-authored-exact-value"))
        #expect(model.output == applied && !model.isBusy)
    }

    @Test func changedDraftDiscardsALateApplyEvenWhenTheTransportIgnoresCancellation() async throws {
        let transport = WorkbenchTransport(hold: true)
        let model = workbench(transport: transport)
        configure(model, result: try source())
        var applyCount = 0
        model.didApply = { _ in applyCount += 1 }
        let run = Task { await model.run(apply: true) }
        await transport.waitForRequest()
        #expect(model.isBusy)
        model.draft.config["steps"] = .array([.object(["type": .string("convert")])])
        await transport.release()
        await run.value
        #expect(applyCount == 0 && model.output == nil && model.error == nil && !model.isBusy)
        model.cancel()
    }

    @Test func supersededPreviewCannotDisplayAnEarlierServerResponse() async throws {
        let transport = WorkbenchTransport(hold: true)
        let model = workbench(transport: transport, delay: .zero)
        configure(model, result: try source())
        model.draft.formulas = [
            .object(["id": .string("old"), "expression": .string("row.amount"), "scope": .string("row")])
        ]
        await transport.waitForRequest()
        #expect(model.previewBusy)
        configure(model, result: try source(), stale: true)
        await transport.release()
        for _ in 0..<8 { await Task.yield() }
        #expect(model.preview == nil && model.previewError == nil && !model.previewBusy)
        model.cancel()
    }

    private func workbench(transport: WorkbenchTransport = WorkbenchTransport(), delay: Duration = .seconds(3600))
        -> AnalysisWorkbenchModel
    {
        AnalysisWorkbenchModel(
            service: APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0),
            previewDelay: delay)
    }
    private func configure(_ model: AnalysisWorkbenchModel, result: AnalysisResult, stale: Bool = false) {
        model.configure(
            result: result, workbench: .object([:]), formulasJson: "[]", assumptionsJson: "[]",
            assumptionValuesJson: "{}", sourceStale: stale)
    }
    private func source(hasMore: Bool = false) throws -> AnalysisResult {
        try TaxValue.object([
            "startedAt": .string("2026-10-13T00:00:00Z"), "completedAt": .string("2026-10-13T00:00:01Z"),
            "executor": .string("synthetic-test"), "byteLength": .number(128),
            "generatedSql": .string("SELECT fixture"),
            "rows": .array([.object(["amount": .string("12345678901234567890.123456789")])]),
            "columns": .array([.object(["id": .string("amount"), "type": .string("decimal")])]),
            "declaredColumns": .array([
                .object([
                    "id": .string("amount"), "type": .string("decimal"), "label": .string("Amount"),
                    "unit": .object(["kind": .string("money"), "currency": .string("EUR")]),
                ])
            ]),
            "window": .object([
                "kind": .string("page"), "offset": .number(0), "limit": .number(10), "hasMore": .bool(hasMore),
                "returnedRows": .number(1),
            ]),
            "coverage": .object(["complete": .bool(true), "status": .string("complete")]),
        ]).decode(AnalysisResult.self)
    }
}

private actor WorkbenchTransport: APITransport {
    private(set) var requests: [TaxValue] = []
    private let hold: Bool
    private var response: CheckedContinuation<Void, Never>?
    private var arrival: CheckedContinuation<Void, Never>?
    init(hold: Bool = false) { self.hold = hold }
    func waitForRequest() async { if requests.isEmpty { await withCheckedContinuation { arrival = $0 } } }
    func release() {
        response?.resume()
        response = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(try JSONDecoder().decode(TaxValue.self, from: request.body ?? Data()))
        if hold {
            await withCheckedContinuation {
                response = $0
                arrival?.resume()
                arrival = nil
            }
        } else {
            arrival?.resume()
            arrival = nil
        }
        return APIResponse(
            status: 200,
            body: try APIBody.encode(
                TaxValue.object([
                    "ok": .bool(true),
                    "data": .object([
                        "rows": .array([]), "columns": .array([]),
                        "summaries": .object(["total": .string("server-authored-exact-value")]),
                    ]),
                ])))
    }
}
