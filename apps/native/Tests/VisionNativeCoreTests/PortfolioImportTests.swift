import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native portfolio import staging and receipts")
struct PortfolioImportTests {
    @Test func terminalLessSSEAndDuplicateTerminalsCannotInventSuccessfulImport() async throws {
        let transport = ImportReceiptTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0,
            streamTransport: transport)
        await #expect(throws: PortfolioImportFailure.self) {
            try await client.importStream(
                file: importFile("synthetic.csv"), config: PortfolioImportConfig(), adapterName: "synthetic",
                onProgress: { _ in })
        }
        await transport.setStream(
            "event: review_required\ndata: {\"batch_id\":7,\"skipped\":0}\n\nevent: review_required\ndata: {\"batch_id\":7}\n\n"
        )
        await #expect(throws: PortfolioImportFailure.self) {
            try await client.importStream(
                file: importFile("synthetic.csv"), config: PortfolioImportConfig(), adapterName: "synthetic",
                onProgress: { _ in })
        }
        await transport.setStream("event: review_required\ndata: {\"batch_id\":7,\"skipped\":0}\n\n")
        let outcome = try await client.importStream(
            file: importFile("synthetic.csv"), config: PortfolioImportConfig(), adapterName: "synthetic",
            onProgress: { _ in })
        #expect(outcome.batchId == 7)
        #expect(outcome.requiresReview)
    }

    @Test func actualParserAPIUsesCompleteUnknownPreservingJSONAndProbeUsesCamelSkipRows() async throws {
        let transport = ImportReceiptTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0,
            streamTransport: transport)
        var config = PortfolioImportConfig.preset("ibkr")!
        config.accountId = 42
        config.skipRows = 2
        config.setValue(.string("retain"), for: "future_key")
        let saved = try await client.importSaveParser(id: nil, name: "Synthetic", config: config)
        #expect(saved.config == config)
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(await transport.requests.first?.body))
        #expect(body["config"]?["dateColumn"] == .string("Date"))
        #expect(body["config"]?["future_key"] == .string("retain"))
        _ = try await client.importProbe(file: importFile("synthetic.csv"), config: config)
        let request = try #require(await transport.requests.last)
        let multipart = String(decoding: try #require(request.body), as: UTF8.self)
        #expect(multipart.contains("name=\"skipRows\"\r\n\r\n2"))
        #expect(!multipart.contains("name=\"skip_rows\""))
        config.encoding = "iso-8859-1"
        _ = try await client.importProbe(file: importFile("synthetic.csv"), config: config)
        let aliasRequest = try #require(await transport.requests.last)
        #expect(
            String(decoding: try #require(aliasRequest.body), as: UTF8.self).contains("name=\"encoding\"\r\n\r\nlatin1")
        )
        #expect(config.encoding == "iso-8859-1")
    }

    @Test func bulkResolutionSendsBigintStringsAndRejectsUnverifiedCount() async throws {
        let transport = ImportReceiptTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        try await client.importOverride(batchId: 7, rowIds: ["9007199254740993"], investmentId: 8, createNew: false)
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(await transport.requests.last?.body))
        #expect(body["row_ids"] == .array([.string("9007199254740993")]))
        await transport.setResolvedCount(0)
        await #expect(throws: PortfolioImportFailure.self) {
            try await client.importOverride(batchId: 7, rowIds: ["9007199254740993"], investmentId: 8, createNew: false)
        }
    }
    @Test func allMaintainedPresetFieldsMatchFrontendGolden() throws {
        let expected = try JSONDecoder().decode(
            [String: TaxValue].self,
            from: Data(
                #"{"default":{"dateColumn":"","typeColumn":"","symbolColumn":"","nameColumn":"","unitsColumn":"","priceColumn":"","amountColumn":"","feesColumn":"","taxesColumn":"","currencyColumn":"","fxRateColumn":"","noteColumn":"","dateFormat":"%Y-%m-%d","separator":",","encoding":"utf-8","skipRows":0,"number_format":"auto","defaultAssetClass":"stock","defaultType":"buy","typeMapping":{}},"ibkr":{"dateColumn":"Date","typeColumn":"Transaction Type","symbolColumn":"Symbol","nameColumn":"","unitsColumn":"Quantity","priceColumn":"Price","amountColumn":"Gross Amount","feesColumn":"Commission","taxesColumn":"","currencyColumn":"Price Currency","fxRateColumn":"Exchange Rate","noteColumn":"Description","dateFormat":"%Y-%m-%d","separator":",","encoding":"utf-8","skipRows":0,"number_format":"auto","defaultAssetClass":"stock","defaultType":"buy","typeMapping":{"Foreign Tax Withholding":"tax"},"format":"ibkr_transaction_history"},"ibkr_funding_history":{"dateColumn":"Request Date","typeColumn":"Method","symbolColumn":"Reference Number","nameColumn":"","unitsColumn":"","priceColumn":"","amountColumn":"Amount","feesColumn":"","taxesColumn":"","currencyColumn":"","fxRateColumn":"","noteColumn":"Method","dateFormat":"%Y-%m-%d","separator":",","encoding":"utf-8","skipRows":0,"number_format":"decimal_dot","defaultAssetClass":"stock","defaultType":"buy","typeMapping":{},"format":"ibkr_funding_history","sourceIdColumn":"Reference Number","sourceAccountColumn":"Account ID"},"kinesis":{"dateColumn":"DateTime","typeColumn":"Transaction_Type","symbolColumn":"Currency_Code","nameColumn":"","unitsColumn":"Amount","priceColumn":"Trade_Price","amountColumn":"Trade_Value","feesColumn":"Fee","taxesColumn":"","currencyColumn":"Trade_Value_Currency","fxRateColumn":"","noteColumn":"","dateFormat":"%Y-%m-%d","separator":",","encoding":"utf-8","skipRows":0,"number_format":"auto","defaultAssetClass":"crypto","defaultType":"buy","typeMapping":{},"format":"kinesis_transaction_history"},"nexo":{"dateColumn":"Date / Time (UTC)","typeColumn":"Type","symbolColumn":"Output Currency","nameColumn":"","unitsColumn":"Output Amount","priceColumn":"","amountColumn":"USD Equivalent","feesColumn":"Fee","taxesColumn":"","currencyColumn":"Output Currency","fxRateColumn":"","noteColumn":"Details","dateFormat":"%Y-%m-%d %H:%M:%S","separator":",","encoding":"utf-8","skipRows":0,"number_format":"auto","defaultAssetClass":"crypto","defaultType":"buy","typeMapping":{},"format":"nexo_transaction_history"},"nexo_pro":{"dateColumn":"timestamp","typeColumn":"side","symbolColumn":"pair","nameColumn":"","unitsColumn":"filledAmount","priceColumn":"executedPrice","amountColumn":"","feesColumn":"tradingFee","taxesColumn":"","currencyColumn":"feeCurrency","fxRateColumn":"","noteColumn":"","dateFormat":"%Y-%m-%d %H:%M:%S","separator":",","encoding":"utf-8","skipRows":0,"number_format":"auto","defaultAssetClass":"crypto","defaultType":"buy","typeMapping":{},"format":"nexo_pro_spot_history"},"saxo":{"dateColumn":"Transactiedatum","typeColumn":"Acties","symbolColumn":"Instrumentsymbool","nameColumn":"Instrument","unitsColumn":"Acties","priceColumn":"Acties","amountColumn":"Boekingsbedrag","feesColumn":"Totale kosten","taxesColumn":"","currencyColumn":"Instrumentvaluta","fxRateColumn":"Omrekeningskoers","noteColumn":"Opmerking","dateFormat":"%Y-%m-%d","separator":",","encoding":"utf-8","skipRows":0,"number_format":"auto","defaultAssetClass":"stock","defaultType":"buy","typeMapping":{},"format":"saxo_transaction_history"}}"#
                    .utf8))
        for (source, value) in expected {
            let config =
                source == "default" ? PortfolioImportConfig() : try #require(PortfolioImportConfig.preset(source))
            #expect(config.payload == value)
        }
    }

    @Test func parserPresetsAndMultipartKeepMappingAndAccountPlacement() throws {
        var config = try #require(PortfolioImportConfig.preset("ibkr"))
        config.accountId = 42
        config.setValue(.string("retain"), for: "future_key")
        let encoded = try TaxValue(encoding: config)
        #expect(encoded["future_key"] == .string("retain"))
        let fields = Dictionary(
            uniqueKeysWithValues: try config.multipartFields(adapterName: "ibkr_transaction_history"))
        #expect(fields["portfolio_format"] == "ibkr_transaction_history")
        #expect(fields["account_id"] == "42")
        #expect(fields["is_brokerage"] == "true")
        #expect(fields["date_column"] == "Date")
        #expect(fields["amount_column"] == "Gross Amount")
        #expect(fields["type_mapping"] == "{\"Foreign Tax Withholding\":\"tax\"}")
        #expect(fields["future_key"] == nil)
        #expect(PortfolioImportConfig.preset("ibkr_funding_history")?.sourceAccountColumn == "Account ID")
        #expect(PortfolioImportConfig.preset("native_receipts") == nil)
    }

    @Test func accountDetectionRequiresUniqueFullStatementIdentity() {
        let accounts = [importAccount(id: 42, name: "Kinesis"), importAccount(id: 43, name: "Second broker")]
        #expect(PortfolioImportDetected(source: "kinesis", sourceAccountIdentities: []).resolveAccount(accounts) == 42)
        #expect(
            PortfolioImportDetected(source: "kinesis", sourceAccountIdentities: ["Second broker"]).resolveAccount(
                accounts) == 43)
        #expect(
            PortfolioImportDetected(source: "kinesis", sourceAccountIdentities: ["KX", "OTHER"]).resolveAccount(
                accounts) == nil)
        #expect(
            PortfolioImportDetected(source: "kinesis", sourceAccountIdentities: []).resolveAccount(
                accounts + [importAccount(id: 44, name: "Kinesis")]) == nil)
    }

    @Test func webCheckpointRestoresExactKeysAndSourceBoundReviewSettingsWithoutFileBytes() async throws {
        let service = ImportFixtureService()
        let store = PortfolioImportMemorySessionStore()
        let row: TaxValue = .object([
            "id": .string("statement-1"), "name": .string("synthetic.csv"), "accountId": .number(42),
            "batchId": .number(7), "status": .string("staged"),
            "detected": .object(["source": .string("kinesis"), "sourceAccountIdentities": .array([.string("KX")])]),
        ])
        let route =
            "[{\"id\":\"statement-1\",\"name\":\"synthetic.csv\",\"source\":\"kinesis\",\"identities\":[\"KX\"],\"accountId\":42,\"includedSymbols\":\"\"}]"
        store.values[PortfolioImportSessionModel.sessionKey] = try JSONEncoder().encode(TaxValue.array([row]))
        store.values[PortfolioImportSessionModel.settingsKey] = try JSONEncoder().encode(
            TaxValue.object([
                "sourceRoutingKey": .string(route), "batchIds": .array([.number(7)]),
                "policy": .string("preserve_existing"),
            ]))
        let model = PortfolioImportSessionModel(service: service, store: store)
        await model.load()
        #expect(model.ids == [7])
        #expect(model.statements.first?.file == nil)
        #expect(model.policy == "preserve_existing")
        model.setStatementPolicy(id: "statement-1", policy: .preserveExisting)
        await model.flushCheckpoint()
        let saved = try JSONDecoder().decode(
            TaxValue.self, from: #require(store.values[PortfolioImportSessionModel.sessionKey]))
        #expect(saved.arrayValue?.count == 1)
        #expect(saved.arrayValue?.first?["file"] == nil)
        #expect(saved.arrayValue?.first?["data"] == nil)
        #expect(saved.arrayValue?.first?["kind"] == nil)
        let settings = try JSONDecoder().decode(
            TaxValue.self, from: #require(store.values[PortfolioImportSessionModel.settingsKey]))
        #expect(Set(settings.objectValue?.keys.map { $0 } ?? []) == ["sourceRoutingKey", "batchIds", "policy"])
    }

    @Test func reviewSettingsOfAnotherSourceRoutingAreIgnored() async throws {
        let store = PortfolioImportMemorySessionStore()
        store.values[PortfolioImportSessionModel.sessionKey] = try JSONEncoder().encode(
            TaxValue.array([
                .object([
                    "id": .string("statement-1"), "name": .string("synthetic.csv"), "accountId": .number(42),
                    "batchId": .number(7), "status": .string("staged"),
                ])
            ]))
        store.values[PortfolioImportSessionModel.settingsKey] = try JSONEncoder().encode(
            TaxValue.object([
                "sourceRoutingKey": .string("[]"), "batchIds": .array([.number(7)]),
                "policy": .string("prefer_source"),
            ]))
        let model = PortfolioImportSessionModel(service: ImportFixtureService(), store: store)
        await model.load()
        #expect(model.ids == [7] && model.policy == "auto")
    }

    @Test func checkpointsFromTheRemovedExistingHistoryFeatureAreDropped() async throws {
        let store = PortfolioImportMemorySessionStore()
        func entry(_ id: String, batch: Int, kind: String?) -> TaxValue {
            var value: TaxValue = .object([
                "id": .string(id), "name": .string("\(id).csv"), "accountId": .number(42),
                "batchId": .number(Decimal(batch)), "status": .string("staged"),
            ])
            if let kind { value["kind"] = .string(kind) }
            return value
        }
        store.values[PortfolioImportSessionModel.sessionKey] = try JSONEncoder().encode(
            TaxValue.array([
                entry("old-existing", batch: 3, kind: "existing"), entry("old-reference", batch: 4, kind: "reference"),
                entry("current", batch: 7, kind: nil),
            ]))
        let model = PortfolioImportSessionModel(service: ImportFixtureService(), store: store)
        await model.load()
        #expect(model.statements.map(\.id) == ["current"] && model.ids == [7])
    }

    @Test func stopWaitsForCurrentReceiptAndPreservesThePendingBatch() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv"), importFile("two.csv")])
        await service.pause("stream")
        let stage = Task { await model.stage() }
        await service.waitForPause()
        model.stop()
        await service.release()
        await stage.value
        #expect(await service.streamCalls == 1)
        #expect(model.statements.map(\.status) == ["staged", "ready"])
        #expect(model.statements.first?.batchId == 7)
        #expect(model.stopped)
    }

    @Test func forcedLeaveDropsUnstagedFilesOnlyAfterRetainingCurrentUploadReceipt() async {
        let service = ImportFixtureService()
        let store = PortfolioImportMemorySessionStore()
        let model = PortfolioImportSessionModel(service: service, store: store)
        await model.load()
        await model.addFiles([importFile("one.csv"), importFile("two.csv")])
        await service.pause("stream")
        let stage = Task { await model.stage() }
        await service.waitForPause()
        model.discardUnstaged()
        await service.release()
        await stage.value
        await model.flushCheckpoint()
        #expect(model.statements.count == 1)
        #expect(model.ids == [7])
        #expect(model.statements.first?.file == nil)
        #expect(store.values[PortfolioImportSessionModel.sessionKey] != nil)
    }

    @Test func latePreviewCannotAuthorizeAnEditedPolicyScope() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await service.pause("plan")
        let preview = Task { await model.preview() }
        await service.waitForPause()
        model.setPolicy("preserve_existing")
        await service.release()
        await preview.value
        #expect(model.plan == nil)
        #expect(!model.canCommit)
        await model.preview()
        #expect(model.canCommit)
        for _ in 0..<20 { #expect(model.canCommit) }
    }

    @Test func sourceRoutingEditsInvalidateTheReviewAndRetainOldBatchLink() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        #expect(model.canCommit)
        model.setAccount(id: model.statements[0].id, accountId: 43)
        #expect(model.plan == nil && !model.canCommit)
        #expect(model.statements[0].previousBatchIds == [7])
        #expect(model.statements[0].batchId == nil)
    }

    @Test func policyEditsDropTheOwnersAnswersAndTheReview() async {
        let service = ImportFixtureService()
        await service.blockRows([4])
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        await model.choose(batchId: 7, rowId: 4, choice: .keepBoth)
        #expect(model.rowChoices.count == 1)
        model.setStatementPolicy(id: model.statements[0].id, policy: .preferSource)
        #expect(model.rowChoices.isEmpty && model.plan == nil)
        await model.preview()
        await model.choose(batchId: 7, rowId: 4, choice: .keepBoth)
        model.setPolicy("preserve_existing")
        #expect(model.rowChoices.isEmpty && model.plan == nil)
    }

    @Test func ownerAnswersReviewAgainAndTheLatestAnswerWins() async {
        let service = ImportFixtureService()
        await service.blockRows([4])
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        #expect(model.plan?.blockers.count == 1)
        #expect(!model.canCommit)
        await model.choose(batchId: 7, rowId: 4, choice: .sameTransaction)
        #expect(model.rowChoices == [.init(batchId: 7, rowId: 4, choice: .sameTransaction)])
        #expect(model.plan?.blockers.isEmpty == true)
        #expect(model.canCommit)
        #expect(await service.previewScopes.last?.rowChoices.map(\.choice) == [.sameTransaction])
        await model.choose(batchId: 7, rowId: 4, choice: .keepBoth)
        #expect(model.rowChoices.map(\.choice) == [.keepBoth])
        #expect(await service.previewScopes.last?.rowChoices.map(\.choice) == [.keepBoth])
        #expect(await service.previewScopes.count == 3)
    }

    @Test func answersForRowsOutsideTheStagedBatchesAreNeverSent() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        await model.choose(batchId: 99, rowId: 4, choice: .keepBoth)
        #expect(model.rowChoices.isEmpty)
        #expect(await service.previewScopes.count == 1)
    }

    @Test func blockedUnknownAndRetiredOutcomesKeepTheCommitDisabled() async {
        for action in ["blocked", "policy_required", "record_income", "repair_duplicate", "mystery"] {
            let service = ImportFixtureService()
            await service.useActions([action])
            let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
            await model.load()
            await model.addFiles([importFile("one.csv")])
            await model.stage()
            await model.preview()
            #expect(model.plan?.actions.count == 1)
            #expect(!model.canCommit, "\(action)")
        }
        for action in PortfolioImportSessionModel.committableActions.sorted() {
            let service = ImportFixtureService()
            await service.useActions([action])
            let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
            await model.load()
            await model.addFiles([importFile("one.csv")])
            await model.stage()
            await model.preview()
            #expect(model.canCommit, "\(action)")
        }
    }

    @Test func reviewedCommitCompletesStatementsAndKeepsTheBatchErrorCounts() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        await model.commit()
        #expect(model.statements.map(\.status) == ["completed"])
        #expect(model.result?.imported == 1 && model.result?.adopted == 0 && model.result?.duplicates == 0)
        #expect(model.plan == nil && !model.outcomeUncertain && model.error == nil)
        #expect(await service.commitScopes.count == 1)
    }

    @Test func aDefiniteServerRejectionLeavesTheSessionReadyToReviewAgain() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        await service.rejectCommit(
            .client(APIClientError(status: 409, code: .conflict, message: "Existing history changed")))
        await model.commit()
        #expect(model.error == "Existing history changed")
        #expect(!model.outcomeUncertain && model.plan == nil && !model.canCommit)
        #expect(model.statements.map(\.status) == ["staged"])
        #expect(await service.historyCalls == 0)
        await model.preview()
        #expect(model.canCommit)
    }

    @Test func anUnverifiedCommitReceiptIsReportedAndTreatedAsPossiblyApplied() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        await service.rejectCommit(.contract(.init(endpoint: "/api/portfolio/import/reconciliation", issues: [])))
        await model.commit()
        #expect(model.error == "portfolioImport.session.responseUnverified")
        #expect(model.outcomeUncertain && !model.canCommit)
    }

    @Test func reconciliationRequestsCarryNoRemovedFieldsAndEchoTheOwnersAnswers() async throws {
        let transport = ImportReceiptTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0,
            streamTransport: transport)
        let scope = PortfolioImportReconciliationScope(
            batchIds: [7], adoptPolicy: .preserveExisting,
            batchPolicies: [.init(batchId: 7, adoptPolicy: .preferSource)],
            rowChoices: [.init(batchId: 7, rowId: 4, choice: .sameTransaction)])
        let plan = try await client.importReconciliationPreview(scope: scope)
        #expect(plan.rowChoices == scope.rowChoices && plan.batchPolicies == scope.batchPolicies)
        let preview = try JSONDecoder().decode(TaxValue.self, from: #require(await transport.requests.last?.body))
        let keys = Set(preview.objectValue?.keys.map { $0 } ?? [])
        #expect(keys == ["batch_ids", "adopt_policy", "batch_policies", "row_choices"])
        let result = try await client.importReconciliationCommit(scope: scope)
        #expect(result.imported == 1 && result.batches.map(\.batchId) == [7])
        let commit = try JSONDecoder().decode(TaxValue.self, from: #require(await transport.requests.last?.body))
        #expect(commit == preview)
        #expect(await transport.requests.last?.url.path == "/api/portfolio/import/reconciliation/commit")
    }

    @Test func lostReviewedCommitAcknowledgementInvalidatesPlanAndReadsRetainedBatches() async {
        let service = ImportFixtureService()
        let model = PortfolioImportSessionModel(service: service, store: PortfolioImportMemorySessionStore())
        var changes = 0
        model.didMutate = { changes += 1 }
        await model.load()
        await model.addFiles([importFile("one.csv")])
        await model.stage()
        await model.preview()
        await service.loseCommitAcknowledgement()
        let before = changes
        await model.commit()
        #expect(model.outcomeUncertain)
        #expect(model.plan == nil)
        #expect(!model.canCommit)
        #expect(await service.historyCalls >= 1)
        #expect(changes == before + 1)
    }

    @Test func automaticPresetAndCaseSensitiveTypeMappingDoNotLoopProbeRequests() async {
        let service = ImportFixtureService()
        let model = PortfolioImportParserModel(service: service)
        await model.load()
        await model.selectFile(importFile("one.csv"))
        model.config.typeColumn = "Type"
        model.setAccount(42)
        for _ in 0..<3 { await Task.yield() }
        #expect(await service.probeCalls == 1)
        #expect(model.typeValues == ["Buy", "BUY"])
        #expect(model.detected?.source == "kinesis")
    }

    @Test func editsDuringParserSaveRemainDirtyAndPreserveUnknownKeys() async throws {
        let service = ImportFixtureService()
        let model = PortfolioImportParserModel(service: service)
        await model.load()
        await model.selectSource("custom")
        model.parserName = "Synthetic"
        model.config.dateColumn = "Date"
        model.config.symbolColumn = "Symbol"
        model.config.setValue(.string("retain"), for: "future_key")
        await service.pause("save")
        let save = Task { await model.saveParser() }
        await service.waitForPause()
        model.config.feesColumn = "New fees"
        await service.release()
        await save.value
        #expect(model.config.feesColumn == "New fees")
        #expect(model.parserDirty)
        #expect(model.config.payload["future_key"] == .string("retain"))
        #expect(model.notice == "importPage.customParser.saved")
    }

    @Test func delayedOldFileProbeCannotReplaceNewFileHeadersOrPreset() async {
        let service = ImportFixtureService()
        let model = PortfolioImportParserModel(service: service)
        await model.load()
        await service.pause("probe")
        let old = Task { await model.selectFile(importFile("old.csv")) }
        await service.waitForPause()
        await model.selectFile(importFile("new.csv"))
        await service.release()
        await old.value
        #expect(model.file?.filename == "new.csv")
        #expect(model.sampleRows.first?.last == "new.csv")
    }

    @Test func lostAdvancedUploadReceiptBlocksRetryAndStillInvalidatesDerivedData() async {
        let service = ImportFixtureService()
        let model = PortfolioImportParserModel(service: service)
        var changes = 0
        model.didMutate = { changes += 1 }
        await model.load()
        await model.selectFile(importFile("one.csv"))
        await service.failUploads()
        await model.importFile()
        #expect(model.outcomeUncertain)
        #expect(!model.canImport)
        #expect(model.outcome == nil)
        #expect(changes == 1)
        #expect(await service.historyCalls == 1)
    }

    @Test func failedAuthoritativeHistoryRecoveryKeepsUploadRetryDisabled() async {
        let service = ImportFixtureService()
        let model = PortfolioImportParserModel(service: service)
        await model.load()
        await model.selectFile(importFile("synthetic.csv"))
        await service.failUploads()
        await service.failHistoryReads(true)
        await model.importFile()
        model.acknowledgeUncertainOutcome()
        #expect(model.outcomeUncertain)
        #expect(await model.recoverUncertainOutcome() == false)
        #expect(!model.canImport)
        await service.failHistoryReads(false)
        #expect(await model.recoverUncertainOutcome())
        #expect(!model.outcomeUncertain)
        #expect(model.canImport)
    }

    @Test func historyUsesTenRowsAndLostRollbackAcknowledgementRereadsAbortedBatch() async {
        let service = ImportFixtureService()
        let model = PortfolioImportHistoryModel(service: service)
        var confirmed = false
        var changes = 0
        model.didRollback = { id, failed in confirmed = id == 7 && !failed }
        model.didMutate = { changes += 1 }
        await model.load()
        #expect(model.page?.limit == 10)
        await service.loseRollbackAcknowledgement()
        await model.rollback(batchId: 7)
        #expect(model.page?.items.first?.status == "aborted")
        #expect(model.error != nil)
        #expect(confirmed)
        #expect(changes == 1)
    }

    @Test func previewResolutionKeepsBigintStringsAndRejectsCashAndUnrelatedErrorRows() async throws {
        let preview = try importPreviewFixture(batchId: 7)
        #expect(preview.groups[0].resolvableRowIds == ["9007199254740993"])
        var cash = importPreviewWire(batchId: 7)
        var groups = cash["groups"]!.arrayValue!
        groups[0]["is_cash"] = .bool(true)
        cash["groups"] = .array(groups)
        #expect(try cash.decode(PortfolioImportPreview.self).groups[0].resolvableRowIds.isEmpty)
        #expect(PortfolioImportReviewModel.parseBatchId("9007199254740992") == nil)
        #expect(PortfolioImportReviewModel.parseBatchId("7x") == nil)
        #expect(PortfolioImportReviewModel.parseBatchId("7") == 7)
    }

    @Test func missingAccountRoutingAndMalformedDecimalEvidenceCannotBecomeAReviewSource() throws {
        var source = importPreviewWire(batchId: 7)
        source["account_id"] = nil
        #expect(throws: PortfolioImportFailure.self) { try source.decode(PortfolioImportPreview.self) }
        source = importPreviewWire(batchId: 7)
        var groups = source["groups"]!.arrayValue!
        var rows = groups[0]["rows"]!.arrayValue!
        rows[0]["amount"] = .string("123 EUR")
        groups[0]["rows"] = .array(rows)
        source["groups"] = .array(groups)
        let preview = try source.decode(PortfolioImportPreview.self)
        #expect(throws: PortfolioImportFailure.self) { try preview.validate(batchId: 7) }
    }

    @Test func completedCheckpointCannotRestoreAConsumedBatchAsStaged() async throws {
        let service = ImportFixtureService()
        let store = PortfolioImportMemorySessionStore()
        store.values[PortfolioImportSessionModel.sessionKey] = try JSONEncoder().encode(
            TaxValue.array([
                .object([
                    "id": .string("completed"), "name": .string("synthetic.csv"), "status": .string("completed"),
                    "accountId": .number(42), "batchId": .number(7),
                ])
            ]))
        let model = PortfolioImportSessionModel(service: service, store: store)
        await model.load()
        #expect(model.statements.isEmpty)
        #expect(!model.canPreview)
    }

    @Test func delayedSessionBridgeReadBlocksDraftsAndConcurrentLoadsCannotEraseStagedMetadata() async throws {
        let source = try JSONEncoder().encode(
            TaxValue.array([
                .object([
                    "id": .string("retained"), "name": .string("synthetic.csv"), "status": .string("staged"),
                    "accountId": .number(42), "batchId": .number(7),
                ])
            ]))
        let store = DelayedImportStore(source: source)
        let model = PortfolioImportSessionModel(service: ImportFixtureService(), store: store)
        let first = Task { await model.load() }
        await store.waitForRead()
        let second = Task { await model.load() }
        await model.addFiles([importFile("new.csv")])
        model.discardUnstaged()
        #expect(model.locked)
        #expect(model.statements.isEmpty)
        store.release()
        await first.value
        await second.value
        await model.flushCheckpoint()
        #expect(!model.isRestoring)
        #expect(model.ids == [7])
        #expect(model.statements.first?.file == nil)
        let saved = try JSONDecoder().decode(
            [PortfolioImportStatement].self, from: #require(store.values[PortfolioImportSessionModel.sessionKey]))
        #expect(saved.map(\.batchId) == [7])
    }
}

@MainActor private final class DelayedImportStore: PortfolioImportSessionStore {
    var values: [String: Data]
    private var began = false
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    init(source: Data) { values = [PortfolioImportSessionModel.sessionKey: source] }
    func read(key: String) async -> Data? {
        if key == PortfolioImportSessionModel.sessionKey {
            began = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
        return values[key]
    }
    func write(key: String, data: Data?) async { values[key] = data }
    func waitForRead() async { if !began { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
}

private actor ImportReceiptTransport: APITransport, APIStreamTransport {
    var requests: [APIRequest] = []
    private var streamText =
        "event: progress\ndata: {\"phase\":\"parsing\",\"current\":1,\"total\":1,\"imported\":0,\"duplicates\":0,\"errors\":0,\"percent\":40}\n\n"
    private var resolvedCount = 1
    func setStream(_ text: String) { streamText = text }
    func setResolvedCount(_ count: Int) { resolvedCount = count }
    private func recordStream(_ request: APIRequest) -> String {
        requests.append(request)
        return streamText
    }
    nonisolated func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
        let text = await recordStream(request)
        try await receive(Data(text.utf8))
        return APIResponse(status: 200, body: Data())
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let value: TaxValue
        if request.url.path == "/api/portfolio/import/parsers" {
            let body = try JSONDecoder().decode(TaxValue.self, from: request.body!)
            value = .object([
                "id": .number(1), "name": body["name"]!, "kind": .string("portfolio"), "config": body["config"]!,
                "created_at": .string("2026-01-01"), "updated_at": .string("2026-01-01"),
            ])
        } else if request.url.path == "/api/portfolio/import/probe" {
            value = .object([
                "detected": .null, "detectionError": .null, "preview": .null, "previewError": .null,
                "separator": .string(","),
            ])
        } else if request.url.path == "/api/portfolio/import/reconciliation/preview" {
            let body = try JSONDecoder().decode(TaxValue.self, from: request.body!)
            let choices: [TaxValue] = (body["row_choices"]?.arrayValue ?? []).map { item in
                .object(["batchId": item["batch_id"]!, "rowId": item["row_id"]!, "choice": item["choice"]!])
            }
            let policies: [TaxValue] = (body["batch_policies"]?.arrayValue ?? []).map { item in
                .object(["batchId": item["batch_id"]!, "adoptPolicy": item["adopt_policy"]!])
            }
            value = .object([
                "batchIds": body["batch_ids"]!, "adoptPolicy": body["adopt_policy"] ?? .null,
                "batchPolicies": .array(policies), "rowChoices": .array(choices), "ready": .bool(true),
                "actions": .array([]), "blockers": .array([]), "summary": .object([:]),
            ])
        } else if request.url.path == "/api/portfolio/import/reconciliation/commit" {
            let body = try JSONDecoder().decode(TaxValue.self, from: request.body!)
            let batches: [TaxValue] = (body["batch_ids"]?.arrayValue ?? []).map { id in
                .object([
                    "batch_id": id, "imported": .number(1), "duplicates": .number(0), "adopted": .number(0),
                    "errors": .number(0),
                ])
            }
            value = .object([
                "imported": .number(Decimal(batches.count)), "duplicates": .number(0), "adopted": .number(0),
                "errors": .number(0), "batches": .array(batches),
            ])
        } else if request.url.path.hasSuffix("/rows/investment-override") {
            value = .object([
                "investment_id": .number(8), "created": .bool(false), "resolved": .number(Decimal(resolvedCount)),
            ])
        } else {
            throw APIError.invalidRequest("Unexpected synthetic import request")
        }
        return APIResponse(
            status: 200, body: try JSONEncoder().encode(TaxValue.object(["ok": .bool(true), "data": value])))
    }
}

private func importFile(_ name: String) -> PortfolioImportFile {
    .init(filename: name, data: Data("Date,Type,Symbol\n2026-01-01,Buy,SYN".utf8))
}
private func importAccount(id: Int, name: String) -> OpenAPI.Account {
    .init(
        id: id, name: name, currency: "EUR", type: "brokerage", liquidityClass: "liquid", spendable: false,
        inNetWorth: true, taxWrapper: "none", owner: "self", multiCurrencyCash: false, hasCashSleeve: true,
        isActive: true, createdAt: "2026-01-01", updatedAt: "2026-01-01")
}
private func importPreviewFixture(batchId: Int) throws -> PortfolioImportPreview {
    try importPreviewWire(batchId: batchId).decode(PortfolioImportPreview.self)
}
private func importPreviewWire(batchId: Int) -> TaxValue {
    var row: TaxValue = .object([
        "id": .string("9007199254740993"), "row_index": .number(0), "status": .string("error"),
        "route": .string("portfolio"), "error_message": .string("unresolved instrument — pick or create a holding"),
    ])
    for key in [
        "tx_date", "type", "type_raw", "symbol_raw", "name_raw", "units", "price_per_unit", "amount", "fees", "taxes",
        "currency", "fx_rate_to_eur", "note", "match_source", "user_override_investment_id",
    ] { row[key] = .null }
    var other = row
    other["id"] = .string("9007199254740994")
    other["error_message"] = .string("unproven economics")
    return .object([
        "batch_id": .number(Decimal(batchId)), "account_id": .number(42), "account_name": .string("Kinesis"),
        "account_valid": .bool(true),
        "totals": .object([
            "symbol": .number(0), "name_exact": .number(0), "unresolved": .number(1), "error": .number(1),
        ]),
        "groups": .array([
            .object([
                "is_cash": .bool(false), "investment_id": .null, "investment_name": .null, "investment_symbol": .null,
                "investment_asset_class": .null, "raw_symbol": .string("SYN"), "raw_name": .null,
                "row_count": .number(2), "rows": .array([row, other]),
            ])
        ]),
    ])
}

private actor ImportFixtureService: PortfolioImportService {
    var streamCalls = 0
    var historyCalls = 0
    var probeCalls = 0
    private var pausedOperation: String?
    private var paused = false
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var lostCommit = false
    private var lostRollback = false
    private var uploadsFail = false
    private var batchStatus = "complete"
    private var historyFails = false
    private var blockedRows: [Int] = []
    private var planActions: [String] = []
    private var commitFailure: APIError?
    private(set) var previewScopes: [PortfolioImportReconciliationScope] = []
    private(set) var commitScopes: [PortfolioImportReconciliationScope] = []
    func failHistoryReads(_ fail: Bool) { historyFails = fail }
    func blockRows(_ rows: [Int]) { blockedRows = rows }
    func useActions(_ actions: [String]) { planActions = actions }
    func rejectCommit(_ failure: APIError) { commitFailure = failure }
    func pause(_ operation: String) {
        pausedOperation = operation
        paused = false
    }
    func waitForPause() async { if !paused { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
    private func wait(_ operation: String) async {
        if pausedOperation == operation {
            pausedOperation = nil
            paused = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
    }
    func loseCommitAcknowledgement() { lostCommit = true }
    func loseRollbackAcknowledgement() { lostRollback = true }
    func failUploads() { uploadsFail = true }
    func importProbe(file: PortfolioImportFile, config: PortfolioImportConfig) async throws -> PortfolioImportProbe {
        probeCalls += 1
        await wait("probe")
        return try TaxValue.object([
            "detected": .object(["source": .string("kinesis"), "sourceAccountIdentities": .array([.string("KX")])]),
            "detectionError": .null,
            "preview": .object([
                "headers": .array([.string("Date"), .string("Type"), .string("Symbol")]),
                "rows": .array([
                    .array([.string("2026-01-01"), .string("Buy"), .string(file.filename)]),
                    .array([.string("2026-01-02"), .string("BUY"), .string("SYN")]),
                ]),
            ]), "previewError": .null, "separator": .string(","),
        ]).decode(PortfolioImportProbe.self)
    }
    func importParsers() async throws -> [PortfolioImportParser] { [] }
    func importSaveParser(id: Int?, name: String, config: PortfolioImportConfig) async throws -> PortfolioImportParser {
        await wait("save")
        return try TaxValue.object([
            "id": .number(Decimal(id ?? 1)), "name": .string(name), "kind": .string("portfolio"),
            "config": config.payload, "created_at": .string("2026-01-01"), "updated_at": .string("2026-01-01"),
        ]).decode(PortfolioImportParser.self)
    }
    func importDeleteParser(id: Int) async throws {}
    func importAccounts() async throws -> [OpenAPI.Account] {
        [importAccount(id: 42, name: "Kinesis"), importAccount(id: 43, name: "Other broker")]
    }
    func importInvestments() async throws -> [PortfolioInvestment] { [] }
    func importStream(
        file: PortfolioImportFile, config: PortfolioImportConfig, adapterName: String,
        onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> PortfolioImportOutcome {
        streamCalls += 1
        await wait("stream")
        if uploadsFail { throw PortfolioImportFailure.ambiguous("Synthetic lost upload receipt") }
        return try TaxValue.object(["batch_id": .number(7), "requires_review": .bool(true), "skipped": .number(0)])
            .decode(PortfolioImportOutcome.self)
    }
    func importBatches(limit: Int, offset: Int) async throws -> PortfolioImportBatchPage {
        historyCalls += 1
        if historyFails { throw APIError.network("Synthetic retained history failure") }
        return try TaxValue.object([
            "items": .array([
                .object([
                    "id": .string("7"), "adapter_name": .string("ibkr_transaction_history"), "account_id": .number(42),
                    "status": .string(batchStatus), "rows_total": .number(2), "rows_error": .number(0),
                ])
            ]), "total": .number(1), "limit": .number(Decimal(limit)), "offset": .number(Decimal(offset)),
        ]).decode(PortfolioImportBatchPage.self)
    }
    func importPreview(batchId: Int) async throws -> PortfolioImportPreview {
        try importPreviewFixture(batchId: batchId)
    }
    func importOverride(batchId: Int, rowIds: [String], investmentId: Int?, createNew: Bool) async throws {}
    func importCommit(batchId: Int, accountId: Int?) async throws -> PortfolioImportCommitResult {
        try TaxValue.object([
            "batch_id": .number(Decimal(batchId)), "total": .number(2), "imported": .number(2),
            "duplicates": .number(0), "errors": .number(0),
        ]).decode(PortfolioImportCommitResult.self)
    }
    func importRollback(batchId: Int) async throws -> Int {
        batchStatus = "aborted"
        if lostRollback { throw APIError.network("Synthetic lost rollback acknowledgement") }
        return 2
    }
    func importReconciliationPreview(scope: PortfolioImportReconciliationScope) async throws
        -> PortfolioImportReconciliationPlan
    {
        previewScopes.append(scope)
        await wait("plan")
        let answered = Set(scope.rowChoices.map(\.rowId))
        let blockers: [TaxValue] = blockedRows.filter { !answered.contains($0) }.map { row in
            .object([
                "batchId": .number(Decimal(scope.batchIds[0])), "rowId": .number(Decimal(row)),
                "rowOrdinal": .number(Decimal(row)), "reason": .string("funding_date_mismatch"),
                "candidateTransactionIds": .array([.number(9)]),
            ])
        }
        let actions: [TaxValue] = planActions.enumerated().map { index, action in
            var value: TaxValue = .object([
                "batchId": .number(Decimal(scope.batchIds[0])), "rowId": .number(Decimal(index + 1)),
                "rowOrdinal": .number(Decimal(index + 1)), "action": .string(action),
                "existingTransactionId": .number(9),
            ])
            if action == "adjustment" {
                value["adjustment"] = .object([
                    "date": .string("2025-01-01"), "units": .string("1"), "kind": .string("asset_fee"),
                    "basisPolicy": .string("carried"), "accountId": .number(42),
                ])
            }
            return value
        }
        return try TaxValue.object([
            "batchIds": .array(scope.batchIds.map { .number(Decimal($0)) }),
            "adoptPolicy": scope.adoptPolicy.map { .string($0.rawValue) } ?? .null,
            "batchPolicies": .array(
                scope.sortedBatchPolicies.map {
                    .object(["batchId": .number(Decimal($0.batchId)), "adoptPolicy": .string($0.adoptPolicy.rawValue)])
                }),
            "rowChoices": .array(
                scope.sortedRowChoices.map {
                    .object([
                        "batchId": .number(Decimal($0.batchId)), "rowId": .number(Decimal($0.rowId)),
                        "choice": .string($0.choice.rawValue),
                    ])
                }),
            "ready": .bool(blockers.isEmpty), "actions": .array(actions), "blockers": .array(blockers),
            "summary": .object([:]),
        ]).decode(PortfolioImportReconciliationPlan.self)
    }
    func importReconciliationCommit(scope: PortfolioImportReconciliationScope) async throws
        -> PortfolioImportReconciliationResult
    {
        commitScopes.append(scope)
        if lostCommit { throw APIError.network("Synthetic lost reviewed commit acknowledgement") }
        if let commitFailure { throw commitFailure }
        return try TaxValue.object([
            "imported": .number(Decimal(scope.batchIds.count)), "duplicates": .number(0), "adopted": .number(0),
            "errors": .number(0),
            "batches": .array(
                scope.batchIds.map {
                    .object([
                        "batch_id": .number(Decimal($0)), "imported": .number(1), "duplicates": .number(0),
                        "adopted": .number(0), "errors": .number(0),
                    ])
                }),
        ]).decode(PortfolioImportReconciliationResult.self)
    }
}
