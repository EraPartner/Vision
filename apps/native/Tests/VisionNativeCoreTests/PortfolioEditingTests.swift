import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Portfolio draft money and patch semantics")
struct PortfolioEditingDraftTests {
    @Test func typedInputFollowsTheWebLimitsAndUpperCasesTheTicker() {
        #expect(PortfolioInvestmentDraft.input("vwce.de", field: "symbol") == "VWCE.DE")
        #expect(PortfolioInvestmentDraft.input(String(repeating: "a", count: 25), field: "symbol").count == 20)
        #expect(PortfolioInvestmentDraft.input(String(repeating: "n", count: 120), field: "name").count == 100)
        #expect(PortfolioInvestmentDraft.input(String(repeating: "l", count: 250), field: "location").count == 200)
        #expect(PortfolioInvestmentDraft.input(String(repeating: "m", count: 250), field: "municipality").count == 200)
        #expect(PortfolioInvestmentDraft.input(String(repeating: "x", count: 600), field: "notes").count == 500)
        #expect(PortfolioInvestmentDraft.input("1.234,5", field: "initialAmount") == "1.234,5")
        #expect(PortfolioInvestmentDraft.input("lower", field: "name") == "lower")
    }
    @Test func unitDerivationMatchesPrecisionAndAcceptsBrokerCentRounding() {
        let math = PortfolioUnitInput(amount: 100, units: 3, price: Decimal(string: "33.33"))
        #expect(math.consistent)
        #expect(PortfolioUnitInput(amount: 100, units: 3, price: nil).price == Decimal(string: "33.333333"))
        #expect(PortfolioUnitInput(amount: nil, units: 3, price: Decimal(string: "33.333333")).amount == 100)
        #expect(!PortfolioUnitInput(amount: 100, units: 3, price: 32).consistent)
    }
    @Test func editClearsUseExplicitNullAndZeroWhileAddOmitsEmptyFields() throws {
        let raw = try editingInvestment()
        var edit = PortfolioTradeDraft(
            investment: raw, transaction: try editingTransaction(), settings: .init(numberFormat: .us))
        edit.amount = "100"
        edit.units = "2"
        edit.pricePerUnit = "50"
        edit.fees = ""
        edit.taxes = ""
        edit.fxRateToEur = ""
        edit.note = ""
        edit.accountId = nil
        edit.isRecurring = false
        let body = try edit.payload(format: .us, defaultBroker: 5)
        #expect(body.fields["fees"] == .number(0))
        #expect(body.fields["taxes"] == .number(0))
        for key in ["fx_rate_to_eur", "note", "account_id", "recurrence_end_date"] {
            #expect(body.fields[key] == .null)
        }
        let bytes = try APIBody.encode(body)
        let encoded = try JSONDecoder().decode(TaxValue.self, from: bytes)
        #expect(encoded["fx_rate_to_eur"] == .null)
        #expect(encoded["account_id"] == .null)
        var add = PortfolioTradeDraft(investment: raw, bookingCurrency: "EUR", today: "2026-10-13")
        add.amount = "100"
        add.units = "2"
        add.pricePerUnit = "50"
        let added = try add.payload(format: .us, defaultBroker: nil)
        for key in ["fees", "taxes", "fx_rate_to_eur", "note", "account_id", "recurrence_end_date"] {
            #expect(added.fields[key] == nil)
        }
    }
    @Test func giftAddIsZeroBasisButEditRetainsTheEnteredBasis() throws {
        let investment = try editingInvestment()
        var add = PortfolioTradeDraft(investment: investment, bookingCurrency: "EUR", today: "2026-10-13")
        add.type = "gift"
        add.units = "2"
        add.amount = "10"
        add.pricePerUnit = "5"
        add.fees = "4"
        add.taxes = "2"
        let posted = try add.payload(format: .us, defaultBroker: nil)
        #expect(posted.fields["amount"] == .number(0))
        #expect(posted.fields["fees"] == .number(0))
        #expect(posted.fields["taxes"] == .number(0))
        var edit = PortfolioTradeDraft(
            investment: investment, transaction: try editingTransaction(type: "gift"),
            settings: .init(numberFormat: .us))
        edit.units = "2"
        edit.amount = "10"
        edit.pricePerUnit = "5"
        let patched = try edit.payload(format: .us, defaultBroker: nil)
        #expect(patched.fields["amount"] == .number(10))
        #expect(patched.fields["units"] == .number(2))
    }
    @Test func typedGarbageNegativeFeesAndZeroFxBlockSubmitting() throws {
        var draft = PortfolioTradeDraft(
            investment: try editingInvestment(), bookingCurrency: "EUR", today: "2026-10-13")
        draft.amount = "100"
        draft.units = "2"
        for value in ["garbage", "-1"] {
            draft.fees = value
            #expect(throws: PortfolioFormIssue.self) { try draft.payload(format: .us, defaultBroker: nil) }
        }
        draft.fees = ""
        draft.fxRateToEur = "0"
        #expect(throws: PortfolioFormIssue.self) { try draft.payload(format: .us, defaultBroker: nil) }
    }
    @Test func localeInputAndBookingCurrencyArePreservedWithoutFxConversion() throws {
        var draft = PortfolioTradeDraft(
            investment: try editingInvestment(currency: "USD"), bookingCurrency: "EUR", today: "2026-10-13")
        draft.type = "dividend"
        draft.amount = "1.234,56789"
        draft.dividendAmountConvention = "net"
        let body = try draft.payload(format: .eu, defaultBroker: nil)
        #expect(body.fields["amount"] == .number(Decimal(string: "1234.56789")!))
        #expect(body.fields["currency"] == .string("EUR"))
        #expect(body.fields["dividend_amount_convention"] == .string("net"))
        #expect(body.fields["income_recognition_role"] == nil)
    }
    @Test func rawEditQuoteCurrencyAndPriceStayTogetherAndLiveProvidersDoNotWritePrices() throws {
        let raw = try editingInvestment(currency: "USD", price: "123.4567")
        let draft = PortfolioInvestmentDraft(
            investment: raw, settings: .init(defaultCurrency: "EUR", numberFormat: .us))
        #expect(draft.currency == "USD")
        #expect(draft.currentPrice == "123.4567")
        let body = try draft.payload(format: .us)
        #expect(body.fields["current_price"] == .number(Decimal(string: "123.4567")!))
        let live = PortfolioInvestmentDraft(
            investment: try editingInvestment(provider: "yahoo"), settings: .init(numberFormat: .us))
        #expect(try live.payload(format: .us).fields["current_price"] == nil)
    }
    @Test func emptyProviderFieldsRemainOmittedAndSelectionClearsOnlyTheProviderId() {
        var provider = PortfolioProviderDraft()
        provider.provider = "custom"
        provider.id = " older "
        provider.latestUrl = " https://example.org/quotes "
        provider.latestPath = " "
        #expect(provider.payload["price_provider_latest_url"] == .string("https://example.org/quotes"))
        #expect(provider.payload["price_provider_latest_path"] == nil)
        provider.select("yahoo")
        #expect(provider.id.isEmpty)
        #expect(provider.latestUrl == " https://example.org/quotes ")
    }
    @Test func initialPurchaseRequiresAmountUnitsAndDateBeforeAnInvestmentIsWritten() throws {
        var draft = PortfolioInvestmentDraft(
            settings: .init(numberFormat: .us), today: "2026-10-13", allowedAssetClasses: ["stock"])
        draft.name = "Synthetic holding"
        draft.initialAmount = "100"
        #expect(throws: PortfolioFormIssue.self) { try draft.initialPurchase(format: .us, defaultBroker: nil) }
        draft.initialUnits = "2"
        draft.initialDate = ""
        #expect(throws: PortfolioFormIssue.self) { try draft.initialPurchase(format: .us, defaultBroker: nil) }
        draft.initialDate = "2026-10-13"
        #expect(try draft.initialPurchase(format: .us, defaultBroker: 3)?.fields["price_per_unit"] == .number(50))
        draft.brokerWasChosen = true
        draft.initialAccountId = nil
        #expect(try draft.initialPurchase(format: .us, defaultBroker: 3)?.fields["account_id"] == nil)
    }
}

@Suite("Portfolio editing API wire contracts")
struct PortfolioEditingAPITests {
    @Test func tradePatchForwardsNullClearsAndDecimalMoneyToTheGeneratedOperation() async throws {
        let response = try APIBody.encode(editingTransaction())
        let transport = PortfolioEditingTransport(
            body: "{\"ok\":true,\"data\":\(String(decoding: response, as: UTF8.self))}")
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        _ = try await client.portfolioUpdateTransaction(
            id: 9,
            payload: .init([
                "amount": .number(Decimal(string: "1234.56789")!), "note": .null, "fx_rate_to_eur": .null,
                "account_id": .null,
            ]))
        let request = try #require(await transport.requests.first)
        #expect(request.method == .patch)
        #expect(request.url.path == "/api/investments/transactions/9")
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(request.body))
        #expect(body["amount"] == .number(Decimal(string: "1234.56789")!))
        #expect(body["note"] == .null)
        #expect(body["fx_rate_to_eur"] == .null)
        #expect(body["account_id"] == .null)
    }
    @Test func rawTradeMoneyStringsDecodeAndBrokerHistoryHasNoGlobalLimit() async throws {
        let transaction = try APIBody.encode(editingTransaction())
        var row = try JSONDecoder().decode(TaxValue.self, from: transaction)
        row["amount"] = .string("1234.56789")
        row["units"] = .string("2.12345678")
        let bytes = try APIBody.encode(row)
        let transport = PortfolioEditingTransport(
            body: "{\"ok\":true,\"data\":{\"items\":[\(String(decoding: bytes, as: UTF8.self))],\"total\":1}}")
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let values = try await client.portfolioEditingTransactions(investmentIds: [71, 88])
        #expect(values.first?.amount == Decimal(string: "1234.56789"))
        #expect(values.first?.units == Decimal(string: "2.12345678"))
        let request = try #require(await transport.requests.first)
        #expect(request.url.path == "/api/investments/transactions")
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.contains(.init(name: "investment_ids", value: "71,88")))
        #expect(query.contains(.init(name: "per_investment_limit", value: "1000")))
        #expect(!query.contains { $0.name == "limit" })
    }
    @Test func catalogAcceptsNewBackendProvidersAndImportUsesTheExposureSourcesPath() async throws {
        let catalog = PortfolioEditingTransport(
            body:
                #"{"ok":true,"data":{"providers":[{"key":"new_provider","name":"New provider","description":"Backend hint"}]}}"#
        )
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: catalog, maxRetries: 0)
        #expect(try await client.portfolioPriceProviders().first?.key == "new_provider")
        #expect(await catalog.requests.first?.url.path == "/api/investments/providers")
        let transport = PortfolioEditingTransport(body: #"{"ok":true,"data":{"saved":1}}"#)
        let importer = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let bytes = Data(#"{"classifications":[],"documents":[]}"#.utf8)
        try await importer.portfolioImportExposure(bytes)
        let request = try #require(await transport.requests.first)
        #expect(request.method == .put)
        #expect(request.url.path == "/api/investments/exposure/sources")
        #expect(request.body == bytes)
    }
}

@MainActor @Suite("Portfolio editing state and retries")
struct PortfolioEditingModelTests {
    private let strings = DictionaryStrings(language: .en, table: [:])
    @Test func invalidInitialPurchaseCannotCreateAnEmptyHolding() async {
        let service = EditingFixtureService()
        let model = PortfolioEditingModel(service: service)
        model.configure(settings: .init(numberFormat: .us))
        model.beginAddInvestment(allowedAssetClasses: ["stock"])
        model.investmentDraft?.name = "Synthetic holding"
        model.investmentDraft?.initialAmount = "100"
        #expect(await model.saveEditor(strings: strings) == false)
        #expect(model.issue?.field == "initialUnits")
        #expect(await service.createdInvestmentCalls == 0)
    }
    @Test func initialPurchaseRetryReusesTheInvestmentThatWasAlreadyCreated() async {
        let service = EditingFixtureService()
        await service.failFirstTrade()
        let model = PortfolioEditingModel(service: service)
        model.configure(settings: .init(numberFormat: .us))
        model.beginAddInvestment(allowedAssetClasses: ["stock"])
        model.investmentDraft?.name = "Synthetic holding"
        model.investmentDraft?.initialAmount = "100"
        model.investmentDraft?.initialUnits = "2"
        #expect(await model.saveEditor(strings: strings) == false)
        #expect(model.presentation == .investment)
        #expect(await model.saveEditor(strings: strings))
        #expect(await service.createdInvestmentCalls == 1)
        #expect(await service.createdTradeInvestmentIds == [71, 71])
        #expect(model.presentation == nil)
    }
    @Test func dirtyEditAndTradeDraftsSurviveDismissalAndPristineDraftsReseed() throws {
        let model = PortfolioEditingModel(service: EditingFixtureService())
        let raw = try editingInvestment()
        model.beginEditInvestment(investment: raw)
        model.investmentDraft?.name = "Typed name"
        model.dismissEditor()
        model.beginEditInvestment(investment: raw)
        #expect(model.investmentDraft?.name == "Typed name")
        #expect(model.hasUnsavedChanges)
        model.discardDrafts()
        model.beginAddTransaction(investment: raw, bookingCurrency: "EUR")
        model.tradeDraft?.amount = "123"
        model.dismissEditor()
        #expect(model.hasUnsavedChanges)
        model.beginAddTransaction(investment: raw, bookingCurrency: "EUR")
        #expect(model.tradeDraft?.amount == "123")
        model.dismissEditor()
        model.beginEditInvestment(investment: raw)
        #expect(model.hasUnsavedChanges)
        model.discardDrafts()
        #expect(!model.hasUnsavedChanges)
    }
    @Test func explicitCancelResetsWhileEscapeAndCloseKeepTheDraft() throws {
        let model = PortfolioEditingModel(service: EditingFixtureService())
        let raw = try editingInvestment()
        model.beginEditInvestment(investment: raw)
        model.investmentDraft?.name = "Typed name"
        model.dismissEditor()
        model.beginEditInvestment(investment: raw)
        #expect(model.investmentDraft?.name == "Typed name")
        model.cancelEditor()
        model.beginEditInvestment(investment: raw)
        #expect(model.investmentDraft?.name == raw.name)
        #expect(!model.hasUnsavedChanges)
        model.dismissEditor()
        model.beginAddTransaction(investment: raw, bookingCurrency: "EUR")
        model.tradeDraft?.amount = "123"
        model.cancelEditor()
        model.beginAddTransaction(investment: raw, bookingCurrency: "EUR")
        #expect(model.tradeDraft?.amount.isEmpty == true)
        #expect(!model.hasUnsavedChanges)
    }
    @Test func archivedInvestmentsCannotOpenEditors() throws {
        let model = PortfolioEditingModel(service: EditingFixtureService())
        let archived = try editingInvestment(active: false)
        model.beginEditInvestment(investment: archived)
        model.beginAddTransaction(investment: archived, bookingCurrency: "EUR")
        model.beginEditTransaction(investment: archived, transaction: try editingTransaction())
        #expect(model.presentation == nil)
    }
    @Test func brokerDefaultsPreferTheInstrumentAndIgnoreInactiveAccounts() async throws {
        let model = PortfolioEditingModel(service: EditingFixtureService())
        await model.loadOptions()
        let instrument = try editingTransaction(id: 1, account: 1, date: "2025-01-01")
        let unrelated = try editingTransaction(id: 2, investmentId: 88, account: 2, date: "2026-10-01")
        let inactive = try editingTransaction(id: 3, account: 3, date: "2026-10-10")
        model.bindTransactions([instrument, unrelated, inactive])
        model.beginAddTransaction(investment: try editingInvestment(), bookingCurrency: "EUR")
        #expect(model.defaultBrokerId == 1)
        model.beginAddInvestment()
        #expect(model.defaultBrokerId == 2)
    }
    @Test func failedRetagRetriesKeepTheKeyAndPartialOrOversizeHistoriesNeverWrite() async throws {
        let service = EditingFixtureService()
        await service.failFirstRetag()
        let model = PortfolioEditingModel(service: service)
        await model.loadOptions()
        let tx = try editingTransaction(account: nil)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: [tx], historyComplete: false, brokerId: 1) == false)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: Array(repeating: tx, count: 501), historyComplete: true, brokerId: 1)
                == false)
        #expect(await service.retags.isEmpty)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: [tx], historyComplete: true, brokerId: 1) == false)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: [tx], historyComplete: true, brokerId: 1))
        let bodies = await service.retags
        #expect(bodies.count == 2)
        #expect(bodies[0].fields["idempotency_key"] == bodies[1].fields["idempotency_key"])
        #expect(bodies[0].fields["from_account_id"] == .null)
        #expect(model.retagReceipt?.changedCount == 1)
    }
    @Test func assigningAnotherHoldingCannotDiscardAnAmbiguousRequestsRetryKey() async throws {
        let service = EditingFixtureService()
        await service.failFirstRetag()
        let model = PortfolioEditingModel(service: service)
        await model.loadOptions()
        let first = try editingTransaction(account: nil)
        let second = try editingTransaction(id: 12, investmentId: 88, account: nil)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: [first], historyComplete: true, brokerId: 1) == false)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 88, completeHistory: [second], historyComplete: true, brokerId: 2))
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: [first], historyComplete: true, brokerId: 1))
        let bodies = await service.retags
        #expect(bodies.count == 3)
        #expect(bodies[0].fields["idempotency_key"] == bodies[2].fields["idempotency_key"])
        #expect(bodies[0].fields["idempotency_key"] != bodies[1].fields["idempotency_key"])
    }
    @Test func bulkHistoryProvidesTheGlobalManualBrokerAndSelectedHistoryDoesNotEraseIt() async throws {
        let service = EditingFixtureService()
        let other = try editingTransaction(id: 18, investmentId: 88, account: 2, date: "2026-10-12")
        await service.setBulk([other])
        let model = PortfolioEditingModel(service: service)
        model.bindInvestments([try editingInvestment(), try editingInvestment(id: 88)])
        await model.loadOptions()
        #expect(model.preferredBrokerId(investmentId: 71) == 2)
        model.bindTransactions([try editingTransaction(account: 1, date: "2025-01-01")], investmentId: 71)
        #expect(model.preferredBrokerId(investmentId: 71) == 1)
        #expect(model.preferredBrokerId(investmentId: nil) == 2)
        model.beginAddInvestment()
        #expect(model.defaultBrokerId == 2)
        await model.loadOptions()
        #expect(await service.bulkCalls == 1)
    }
    @Test func failedBulkRefreshCannotSelectAStaleHiddenBrokerOrClearAnExplicitChoice() async throws {
        let service = EditingFixtureService()
        await service.setBulk([try editingTransaction(investmentId: 88, account: 2)])
        let model = PortfolioEditingModel(service: service)
        model.bindInvestments([try editingInvestment(), try editingInvestment(id: 88)])
        await model.loadOptions()
        model.beginAddTransaction(investment: try editingInvestment(), bookingCurrency: "EUR")
        #expect(model.defaultBrokerId == 2)
        model.tradeDraft?.accountId = 1
        model.tradeDraft?.brokerWasChosen = true
        await service.setBulkFailure(true)
        await model.loadBrokerHistory(force: true)
        #expect(model.defaultBrokerId == nil)
        #expect(model.brokerHistoryError != nil)
        #expect(model.tradeDraft?.accountId == 1)
        #expect(model.tradeDraft?.brokerWasChosen == true)
    }
    @Test func aBulkReadStartedBeforeAMutationCannotRestoreOldBrokerMetadata() async throws {
        let service = EditingFixtureService()
        await service.setBulk([try editingTransaction(account: 1)])
        await service.pauseNextBulk()
        let model = PortfolioEditingModel(service: service)
        model.bindInvestments([try editingInvestment()])
        let old = Task { await model.loadOptions() }
        await service.waitForBulkPause()
        #expect(await model.archiveInvestment(id: 71))
        await service.setBulk([try editingTransaction(account: 2)])
        await model.loadBrokerHistory(force: true)
        await service.releaseBulk()
        await old.value
        #expect(model.preferredBrokerId(investmentId: 71) == 2)
        #expect(!model.brokerHistoryLoading)
    }
    @Test func mutationFailureDoesNotRefreshReadModelsAndReportsAnError() async {
        let service = EditingFixtureService()
        await service.failUpdates()
        let model = PortfolioEditingModel(service: service)
        var reloads = 0
        model.bindChanged { reloads += 1 }
        #expect(await model.archiveInvestment(id: 71) == false)
        #expect(reloads == 0)
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "portfolio.updateInvestmentFailedTitle")
        #expect(model.notice?.detail == "apiError.network")
        #expect(model.error == "apiError.network")
        #expect(await model.setTicker(id: 71, visible: false) == false)
        #expect(model.notice?.key == "portfolio.updateInvestmentFailedTitle")
    }
    @Test func mutationFailuresUseTheirWebToastTitlesWithHumanizedDetail() async throws {
        let service = EditingFixtureService()
        await service.failDeletes()
        let model = PortfolioEditingModel(service: service)
        model.configure(settings: .init(numberFormat: .us), strings: strings)
        #expect(await model.deleteInvestment(id: 71) == false)
        #expect(model.notice?.key == "portfolio.deleteInvestmentFailedTitle")
        #expect(model.notice?.detail == "apiError.network")
        #expect(await model.deleteTransaction(id: 9) == false)
        #expect(model.notice?.key == "portfolio.deleteTxnFailedTitle")
        await model.loadOptions()
        await service.failFirstRetag()
        let lot = try editingTransaction(account: nil)
        #expect(
            await model.assignUnassignedLots(
                investmentId: 71, completeHistory: [lot], historyComplete: true, brokerId: 1) == false)
        #expect(model.notice?.key == "portfolio.assignLotsFailedTitle")
    }
    @Test func exposureImportFailureIsReportedInlineWithoutAToast() async {
        let service = EditingFixtureService()
        await service.failExposureImport()
        let model = PortfolioEditingModel(service: service)
        #expect(await model.importExposure(data: Data("{}".utf8)) == false)
        #expect(model.notice == nil)
        #expect(model.error == "apiError.network")
    }
    @Test func formSaveFailuresToastTheFailedStepAndKeepTheInlineError() async throws {
        let service = EditingFixtureService()
        await service.failFirstTrade()
        let model = PortfolioEditingModel(service: service)
        model.configure(settings: .init(numberFormat: .us))
        model.beginAddInvestment(allowedAssetClasses: ["stock"])
        model.investmentDraft?.name = "Synthetic holding"
        model.investmentDraft?.initialAmount = "100"
        model.investmentDraft?.initialUnits = "2"
        #expect(await model.saveEditor(strings: strings) == false)
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "portfolio.recordTxnFailedTitle")
        #expect(model.notice?.detail == "apiError.network")
        #expect(model.error == "apiError.network")
        model.discardDrafts()
        await service.failUpdates()
        let investment = try editingInvestment()
        model.beginEditInvestment(investment: investment)
        #expect(await model.saveEditor(strings: strings) == false)
        #expect(model.notice?.key == "portfolio.updateInvestmentFailedTitle")
        await service.failFirstCreate()
        model.discardDrafts()
        model.beginAddInvestment(allowedAssetClasses: ["stock"])
        model.investmentDraft?.name = "Synthetic holding"
        model.investmentDraft?.addInitialPurchase = false
        #expect(await model.saveEditor(strings: strings) == false)
        #expect(model.notice?.key == "portfolio.createInvestmentFailedTitle")
    }
}

private func editingInvestment(
    id: Int = 71, active: Bool = true, currency: String = "EUR", price: String = "50", provider: String = "manual"
) throws -> PortfolioInvestment {
    let value =
        "{\"id\":\(id),\"name\":\"Synthetic holding\",\"symbol\":\"TEST\",\"asset_class\":\"stock\",\"currency\":\"\(currency)\",\"current_price\":\(price),\"price_provider\":\"\(provider)\",\"is_active\":\(active),\"show_in_ticker\":true,\"created_at\":\"2025-01-01\",\"updated_at\":\"2025-01-01\"}"
    return try JSONDecoder().decode(PortfolioInvestment.self, from: Data(value.utf8))
}
private func editingTransaction(
    id: Int = 9, investmentId: Int = 71, type: String = "buy", account: Int? = 1, date: String = "2025-01-01"
) throws -> PortfolioTransaction {
    let value =
        "{\"id\":\(id),\"investment_id\":\(investmentId),\"type\":\"\(type)\",\"date\":\"\(date)\",\"amount\":100,\"units\":2,\"price_per_unit\":50,\"currency\":\"EUR\",\"account_id\":\(account.map(String.init) ?? "null"),\"is_recurring\":false,\"created_at\":\"\(date)\",\"updated_at\":\"\(date)\",\"income_recognition_role\":\"standard\",\"dividend_amount_convention\":\"unknown\"}"
    return try JSONDecoder().decode(PortfolioTransaction.self, from: Data(value.utf8))
}
private func editingBroker(id: Int, active: Bool = true) -> OpenAPI.Account {
    .init(
        id: id, name: "Synthetic broker \(id)", currency: "EUR", type: "brokerage", liquidityClass: "portfolio",
        spendable: false,
        inNetWorth: true, taxWrapper: "none", owner: "me", multiCurrencyCash: false, hasCashSleeve: true,
        isActive: active, createdAt: "2025-01-01", updatedAt: "2025-01-01")
}
private actor EditingFixtureService: PortfolioEditingService {
    var createdInvestmentCalls = 0
    var createdTradeInvestmentIds: [Int] = []
    var retags: [PortfolioEditingPayload] = []
    private var tradeFails = false
    private var retagFails = false
    private var updateFails = false
    private var deleteFails = false
    private var createFails = false
    private var exposureFails = false
    var bulkCalls = 0
    private var bulkRows: [PortfolioTransaction] = []
    private var bulkFails = false
    private var pauseBulk = false
    private var heldBulk: CheckedContinuation<Void, Never>?
    private var enteredBulk: CheckedContinuation<Void, Never>?
    func setBulk(_ rows: [PortfolioTransaction]) { bulkRows = rows }
    func setBulkFailure(_ fail: Bool) { bulkFails = fail }
    func pauseNextBulk() { pauseBulk = true }
    func waitForBulkPause() async {
        if heldBulk != nil { return }
        await withCheckedContinuation { enteredBulk = $0 }
    }
    func releaseBulk() {
        heldBulk?.resume()
        heldBulk = nil
    }

    func failFirstTrade() { tradeFails = true }
    func failFirstRetag() { retagFails = true }
    func failUpdates() { updateFails = true }
    func failDeletes() { deleteFails = true }
    func failFirstCreate() { createFails = true }
    func failExposureImport() { exposureFails = true }
    func portfolioCreateInvestment(_ payload: PortfolioEditingPayload) async throws -> PortfolioInvestment {
        if createFails {
            createFails = false
            throw APIError.backendUnavailable
        }
        createdInvestmentCalls += 1
        return try editingInvestment()
    }
    func portfolioUpdateInvestment(id: Int, payload: PortfolioEditingPayload) async throws -> PortfolioInvestment {
        if updateFails { throw APIError.backendUnavailable }
        return try editingInvestment()
    }
    func portfolioDeleteInvestment(id: Int) async throws {
        if deleteFails { throw APIError.backendUnavailable }
    }
    func portfolioCreateTransaction(investmentId: Int, payload: PortfolioEditingPayload) async throws
        -> PortfolioTransaction
    {
        createdTradeInvestmentIds.append(investmentId)
        if tradeFails {
            tradeFails = false
            throw APIError.backendUnavailable
        }
        return try editingTransaction()
    }
    func portfolioUpdateTransaction(id: Int, payload: PortfolioEditingPayload) async throws -> PortfolioTransaction {
        try editingTransaction()
    }
    func portfolioDeleteTransaction(id: Int) async throws {
        if deleteFails { throw APIError.backendUnavailable }
    }
    func portfolioPriceProviders() async throws -> [PortfolioPriceProvider] { PortfolioPriceProvider.fallback }
    func portfolioEditingTransactions(investmentIds: [Int]) async throws -> [PortfolioTransaction] {
        bulkCalls += 1
        let snapshot = bulkRows
        if pauseBulk {
            pauseBulk = false
            await withCheckedContinuation { continuation in
                heldBulk = continuation
                enteredBulk?.resume()
                enteredBulk = nil
            }
        }
        if bulkFails { throw APIError.backendUnavailable }
        return snapshot
    }
    func portfolioEditingAccounts() async throws -> [OpenAPI.Account] {
        [editingBroker(id: 1), editingBroker(id: 2), editingBroker(id: 3, active: false)]
    }
    func portfolioRetagLots(_ payload: PortfolioEditingPayload) async throws -> OpenAPI.PortfolioBrokerRetagReceipt {
        retags.append(payload)
        if retagFails {
            retagFails = false
            throw APIError.backendUnavailable
        }
        return .init(
            receiptId: 1, idempotencyKey: "synthetic", transactionIds: [9], previousAssignments: [], selectedCount: 1,
            changedCount: 1, createdAt: "2026-10-13", replayed: false)
    }
    func portfolioImportExposure(_ data: Data) async throws {
        if exposureFails { throw APIError.backendUnavailable }
    }
}

private actor PortfolioEditingTransport: APITransport {
    let body: String
    var requests: [APIRequest] = []
    init(body: String) { self.body = body }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        return APIResponse(status: 200, body: Data(body.utf8))
    }
}
