import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Settings raw authority, debounce and scoped edits")
struct NativeSettingsModelTests {
    @Test func malformedBaselineCannotBecomeWriteAuthority() throws {
        #expect(throws: DecodingError.self) {
            try TaxValue.object(["settings": .object([:]), "expected": .object(["app_settings": .null])]).decode(
                NativeSettingsSnapshot.self)
        }
        #expect(throws: DecodingError.self) {
            try TaxValue.object([
                "key": .string("app_settings"), "value": .null, "expected": .object(["exists": .string("false")]),
            ]).decode(NativeSettingsRecord.self)
        }
        let raw: TaxValue = .object([
            "key": .string("x"), "value": .null,
            "expected": .object(["exists": .bool(false), "future": .string("preserve")]),
        ])
        #expect(try raw.decode(NativeSettingsRecord.self).expected["future"] == .string("preserve"))
    }
    @Test func loadKeepsAbsentDistinctFromNullAndNeverPersistsDefaults() async throws {
        let transport = NativeSettingsFixture(values: [
            "app_settings": .object(["aiAnswerDepth": .null, "future": .number(123.45)])
        ])
        let model = settingsModel(transport)
        await model.load()
        #expect(model.isLoaded && !model.isSaving && model.loadError == nil)
        #expect(model.appValue("aiAnswerDepth") == nil)
        #expect(model.appString("defaultCurrency", fallback: "bad") == "EUR")
        #expect(model.dashboardRaw == NativeSettingsDefaults.dashboard && model.themeRaw == nil)
        await model.flush()
        #expect(await transport.writes.isEmpty)
        #expect(await transport.requests.count == 1)
        await model.loadOptions()
        let requests = await transport.requests
        #expect(requests.first?.url.query == "withBaselines=true")
        #expect(requests.contains { $0.url.path == "/api/recipients" && $0.url.query == "limit=1000" })
    }
    @Test func editableMigrationRepairsKnownFieldsButKeepsRawCASAndOptionalAbsence() async throws {
        let raw: TaxValue = .object([
            "showDecimalPlaces": .number(-1), "analysisBenchmark": .string(" msft "),
            "openAiDefaultModel": .string("legacy"), "future": .bool(true),
        ])
        let dashboard: TaxValue = .object([
            "excludedCategoryIds": .array([.string("invalid")]), "exclusionScope": .string("bad"), "future": .number(5),
        ])
        let transport = NativeSettingsFixture(values: ["app_settings": raw, "dashboard_settings": dashboard])
        let model = settingsModel(transport)
        await model.load()
        #expect(model.appValue("showDecimalPlaces") == .number(2))
        #expect(model.appValue("analysisBenchmark") == .string("MSFT"))
        #expect(model.appValue("openAiDefaultModel") == nil)
        #expect(
            model.excludedCategoryIds.isEmpty
                && model.dashboardString("exclusionScope", fallback: "bad") == "everywhere")
        #expect(await transport.writes.isEmpty)
        model.updateApp(["language": .string("nl")])
        model.updateDashboard(["excludeHiddenCategories": .bool(false)])
        await model.flush()
        let writes = await transport.writes
        let app = writes.first { $0.key == "app_settings" }!
        let dash = writes.first { $0.key == "dashboard_settings" }!
        #expect(app.expected["value"] == raw && dash.expected["value"] == dashboard)
        #expect(app.value["showDecimalPlaces"] == .number(2) && app.value["future"] == .bool(true))
        #expect(dash.value["excludedCategoryIds"] == .array([]) && dash.value["future"] == .number(5))
    }
    @Test func rapidEditsCoalesceWithMigratedDefaultsAndUnknownFields() async throws {
        let unknown: TaxValue = .number(Decimal(string: "123456789.1234567890123456789")!)
        let transport = NativeSettingsFixture(values: ["app_settings": .object(["future": unknown])])
        let model = settingsModel(transport)
        await model.load()
        model.updateApp(["language": .string("nl")])
        model.updateApp(["defaultCurrency": .string("USD")])
        model.setAppValue("aiDefaultModel", .string(""))
        model.setAppValue("analysisBenchmark", .string(" msft "))
        model.setAppValue("analysisBenchmark", nil)
        await model.flush()
        let writes = await transport.writes
        #expect(writes.count == 1)
        #expect(
            writes[0].value
                == NativeSettingsDefaults.migrateApp(
                    .object([
                        "future": unknown, "language": .string("nl"), "defaultCurrency": .string("USD"),
                        "aiDefaultModel": .string(""),
                    ])))
        #expect(writes[0].expected["value"] == .object(["future": unknown]))
    }
    @Test func successiveSavesSerializeAndAdvanceOnlyAcknowledgedBaseline() async throws {
        let transport = NativeSettingsFixture(values: ["app_settings": .object(["language": .string("en")])])
        let model = settingsModel(transport)
        await model.load()
        await transport.gateNextWrite()
        model.updateApp(["language": .string("nl")])
        await waitSettings { await transport.writeIsGated }
        model.updateApp(["defaultCurrency": .string("USD")])
        try await Task.sleep(for: .milliseconds(30))
        #expect(await transport.writes.count == 1)
        await transport.releaseWrite()
        await model.flush()
        let writes = await transport.writes
        #expect(writes.count == 2)
        #expect(writes[1].expected["value"] == writes[0].value)
        #expect(writes[1].value["language"] == .string("nl") && writes[1].value["defaultCurrency"] == .string("USD"))
    }
    @Test func failedWriteNeverRetriesOrGetsRebasedByBackgroundReads() async throws {
        let transport = NativeSettingsFixture(values: ["app_settings": .object(["language": .string("en")])])
        let model = settingsModel(transport)
        await model.load()
        await transport.failNextWrite(status: 503)
        model.updateApp(["language": .string("nl")])
        await model.flush()
        #expect(await transport.writes.count == 1)
        #expect(model.saveErrorNonce == 1 && model.notice?.key == "settings.saveFailed")
        await transport.setValue("app_settings", .object(["language": .string("nl")]))
        await model.load(force: true)
        model.updateApp(["defaultCurrency": .string("GBP")])
        await model.flush()
        #expect(await transport.writes.count == 1)
        #expect(model.saveErrorNonce == 2)
        #expect(await model.persistence.baseline("app_settings")?["value"]?["language"] == .string("en"))
    }
    @Test func rejectedLaneDoesNotBlockIndependentDashboardAndTheme() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        await transport.failNextWrite(status: 409)
        model.updateApp(["language": .string("nl")])
        await model.flush()
        model.updateDashboard(["excludeHiddenCategories": .bool(false)])
        model.updateTheme(["variant": .string("nord")])
        await model.flush()
        #expect(await transport.writes.count == 3)
        #expect(await transport.value("dashboard_settings")?["excludeHiddenCategories"] == .bool(false))
        #expect(await transport.value("theme_settings")?["variant"] == .string("nord"))
    }
    @Test func missingAuthorityRefusesWriteAndReadFailureDoesNotInventAnAbsentBaseline() async throws {
        let transport = NativeSettingsFixture()
        let writer = NativeSettingsPersistence(service: settingsClient(transport))
        await #expect(throws: SettingsWriteError.self) { try await writer.save("app_settings", value: .object([:])) }
        #expect(await transport.writes.isEmpty)
        _ = try await writer.readAll()
        await #expect(throws: SettingsWriteError.self) { try await writer.save("app_settings", value: .object([:])) }
        #expect(await transport.writes.isEmpty)
        #expect(await writer.baseline("new_key") == .object(["exists": .bool(false)]))
    }
    @Test func firstIndividualAuthoritySurvivesCompleteReadAndLaterReads() async throws {
        let transport = NativeSettingsFixture(values: ["x": .null])
        let writer = NativeSettingsPersistence(service: settingsClient(transport))
        _ = try await writer.read("x")
        await transport.setValue("x", .string("other"))
        _ = try await writer.readAll()
        _ = try await writer.read("x")
        #expect(await writer.baseline("x") == .object(["exists": .bool(true), "value": .null]))
        #expect(await writer.baseline("missing") == .object(["exists": .bool(false)]))
        await #expect(throws: APIError.self) { try await writer.save("x", value: .string("mine")) }
    }
    @Test func falseyThemeUsesExplicitLegacyFallbackButRawCASRemainsFalsey() async throws {
        let transport = NativeSettingsFixture(values: ["theme_settings": .number(0)])
        let model = settingsModel(transport)
        model.legacyTheme = .object(["mode": .string("light"), "variant": .string("solarized")])
        await model.load()
        #expect(model.themeString("mode", fallback: "bad") == "light")
        model.updateTheme(["systemAccent": .bool(true)])
        await model.flush()
        #expect(await transport.writes.first?.expected["value"] == .number(0))
    }
    @Test func themeSaveReconstructsFourSourceFieldsAndFailsSilently() async throws {
        let transport = NativeSettingsFixture(values: [
            "theme_settings": .object(["future": .number(9), "variant": .string("nord")])
        ])
        let model = settingsModel(transport)
        await model.load()
        model.updateThemeSchedule(["lightFrom": .string("08:15")])
        await model.flush()
        let writes = await transport.writes
        #expect(Set(writes[0].value.objectValue!.keys) == ["mode", "schedule", "variant", "systemAccent"])
        #expect(writes[0].value["schedule"]?["darkFrom"] == .string("20:00"))
        await transport.failNextWrite(status: 409)
        model.updateTheme(["mode": .string("light")])
        await model.flush()
        #expect(model.saveErrorNonce == 0 && model.saveError == nil && model.notice == nil)
    }
    @Test func includeTransfersRemainsOptimisticAndSilentWhileCashRollsBack() async throws {
        let initial: TaxValue = .object(["dividend": .number(17), "future": .string("keep")])
        let transport = NativeSettingsFixture(values: ["brokerage_cash_category_ids": initial])
        let model = settingsModel(transport)
        await model.load()
        await transport.failNextWrite(status: 409)
        await model.setIncludeTransfers(true)
        #expect(model.includeTransfers && model.notice == nil)
        await transport.failNextWrite(status: 409)
        await model.setCashCategory("fee", 21)
        #expect(model.cashRaw == initial && model.notice?.key == "settings.saveFailed")
        let writes = await transport.writes
        #expect(writes[1].value["future"] == .string("keep") && writes[1].value["tax"] == .null)
    }
    @Test func cashSettingKeepsInactiveUnknownSelectionsAndPreservesOtherKinds() async throws {
        let transport = NativeSettingsFixture(values: [
            "brokerage_cash_category_ids": .object(["dividend": .number(999), "future": .number(2)])
        ])
        let model = settingsModel(transport)
        await model.load()
        await model.setCashCategory("fee", 10)
        #expect(model.cashCategoryId("dividend") == 999 && model.cashCategoryId("fee") == 10)
        await model.setCashCategory("fee", nil)
        #expect(model.cashRaw?["fee"] == .null && model.cashRaw?["future"] == .number(2))
    }
    @Test func resetPreferencesDropsOnlyAppAndDashboardUnknownsAndLeavesOtherSettings() async throws {
        let transport = NativeSettingsFixture(values: [
            "app_settings": .object(["future": .number(1)]), "dashboard_settings": .object(["future": .number(2)]),
            "theme_settings": .object(["variant": .string("nord")]), "cost_basis_method": .string("fifo"),
            "brokerage_cash_category_ids": .object(["fee": .number(17)]),
        ])
        let model = settingsModel(transport)
        await model.load()
        model.isLargeDisplay = true
        model.selectVisualEffects("enhanced")
        await model.resetPreferences()
        await model.flush()
        #expect(model.appRaw == NativeSettingsDefaults.app && model.dashboardRaw == NativeSettingsDefaults.dashboard)
        #expect(model.sessionTierOverride == nil)
        #expect(Set(await transport.writes.map(\.key)) == ["app_settings", "dashboard_settings", "includeTransfers"])
        #expect(await transport.value("cost_basis_method") == .string("fifo"))
        #expect(await transport.value("theme_settings")?["variant"] == .string("nord"))
        #expect(await transport.value("brokerage_cash_category_ids")?["fee"] == .number(17))
    }
    @Test func largeDisplayOverrideNeverPersistsUntilCapIsDisabled() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        model.isLargeDisplay = true
        model.selectVisualEffects("enhanced")
        #expect(model.effectiveVisualEffects == "enhanced" && model.appValue("visualEffects") == .string("standard"))
        await model.flush()
        #expect(await transport.writes.isEmpty)
        model.selectVisualEffects("reduced")
        #expect(model.sessionTierOverride == nil)
        model.selectVisualEffects("enhanced")
        model.setAutoAdaptDisplay(false)
        #expect(model.sessionTierOverride == nil && model.effectiveVisualEffects == "standard")
        await model.flush()
        #expect(await transport.writes.count == 1)
    }
    @Test func fullEffectsIsAnObservablePersistedSettingThatDefaultsOff() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        #expect(!model.fullEffects)
        model.setFullEffects(true)
        #expect(model.fullEffects && model.appValue("fullEffects") == .bool(true))
        await model.flush()
        #expect(await transport.value("app_settings")?["fullEffects"] == .bool(true))
        model.setFullEffects(false)
        #expect(!model.fullEffects)
    }
    @Test func editsDuringForcedReadAreNotOverwrittenByEarlierSnapshot() async throws {
        let transport = NativeSettingsFixture(values: [
            "app_settings": .object(["language": .string("en")]),
            "brokerage_cash_category_ids": .object(["fee": .number(1)]),
        ])
        let model = settingsModel(transport)
        await model.load()
        await transport.gateNextRead()
        let reload = Task { await model.load(force: true) }
        await waitSettings { await transport.readIsGated }
        model.updateApp(["language": .string("nl")])
        await model.setCashCategory("fee", 2)
        await transport.releaseRead()
        await reload.value
        await model.flush()
        #expect(model.appString("language", fallback: "bad") == "nl" && model.cashCategoryId("fee") == 2)
    }
    @Test func costBasisUpdatesTwoKeysAndInvalidatesOnlyAfterTopLevelReceipt() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        var invalidations = 0
        model.didChangeCostBasis = { invalidations += 1 }
        await model.setCostBasisMethod("fifo")
        await model.flush()
        #expect(invalidations == 1)
        #expect(Set(await transport.writes.map(\.key)) == ["app_settings", "cost_basis_method"])
        #expect(model.appString("costBasisMethod", fallback: "bad") == "fifo")
    }
    @Test func recurringResetClearsLocalStateBeforeReceiptAndUsesSourceNotices() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        var cleared = false
        model.clearRecurringLocalState = { cleared = true }
        await model.resetRecurringDismissals()
        #expect(cleared && model.notice?.key == "settings.app.recurringDismissalsResetSuccess")
        #expect(await transport.value("dismissed_recurring_patterns") == .array([]))
    }
    @Test func optionReadsAreSectionScopedAndCacheSuccessfulEmptyListsForSixtySeconds() async throws {
        let transport = NativeSettingsFixture()
        let clock = NativeSettingsFixtureClock(Date(timeIntervalSince1970: 1000))
        let model = NativeSettingsModel(
            service: settingsClient(transport), debounce: .milliseconds(10), now: { clock.value })
        var servicesReads = 0
        model.loadKeepServices = {
            servicesReads += 1
            return true
        }
        await model.load()
        #expect(await transport.requests.count == 1 && servicesReads == 0)
        await model.loadCategories()
        #expect(await transport.requests.count == 2)
        #expect(!(await transport.requests).contains { $0.url.path == "/api/recipients" })
        await model.loadOptions()
        #expect(await transport.requests.count == 3)
        clock.value = clock.value.addingTimeInterval(59)
        await model.loadOptions()
        #expect(await transport.requests.count == 3)
        clock.value = clock.value.addingTimeInterval(2)
        await model.loadOptions()
        #expect(await transport.requests.count == 5)
        await model.loadCategories(force: true)
        #expect(await transport.requests.count == 6)
        await model.loadServices()
        #expect(servicesReads == 1 && model.keepServicesOnQuit)
    }
    @Test func globalNoticeCallbackPublishesAcknowledgedActionsAndErrors() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        var notices: [ScreenNotice] = []
        model.didNotice = { notices.append($0) }
        await model.load()
        await model.resetRecurringDismissals()
        #expect(notices.map(\.key) == ["settings.app.recurringDismissalsResetSuccess"])
        await transport.failNextWrite(status: 409)
        model.updateApp(["language": .string("nl")])
        await model.flush()
        #expect(notices.last?.key == "settings.saveFailed" && notices.count == 2)
    }
    @Test func restoreSuspensionHoldsLatestDebounceAndFailedRestoreResumesSameDraft() async throws {
        let transport = NativeSettingsFixture(values: ["app_settings": .object(["future": .number(7)])])
        let model = NativeSettingsModel(service: settingsClient(transport), debounce: .milliseconds(100))
        await model.load()
        model.updateApp(["language": .string("nl")])
        model.updateApp(["defaultCurrency": .string("USD")])
        await model.suspendForRestore()
        await model.flush()
        #expect(model.isSuspendedForRestore && model.appValue("language") == .string("nl"))
        #expect(await transport.writes.isEmpty)
        model.updateApp(["defaultCurrency": .string("GBP")])
        #expect(model.appValue("defaultCurrency") == .string("USD"))
        model.resumeAfterFailedRestore()
        await model.flush()
        let writes = await transport.writes
        #expect(!model.isSuspendedForRestore && writes.count == 1)
        #expect(writes[0].value["language"] == .string("nl") && writes[0].value["defaultCurrency"] == .string("USD"))
        #expect(writes[0].expected["value"] == .object(["future": .number(7)]))
    }
    @Test func restoreSuspensionDrainsAcceptedWriteBeforeHoldingTheNewerDraft() async throws {
        let transport = NativeSettingsFixture()
        let model = NativeSettingsModel(service: settingsClient(transport), debounce: .milliseconds(40))
        await model.load()
        await transport.gateNextWrite()
        model.updateApp(["language": .string("nl")])
        await waitSettings { await transport.writeIsGated }
        model.updateApp(["defaultCurrency": .string("USD")])
        var drained = false
        let suspension = Task {
            await model.suspendForRestore()
            drained = true
        }
        await waitSettings { model.isSuspendedForRestore }
        #expect(await transport.writes.count == 1 && !drained)
        await transport.releaseWrite()
        await suspension.value
        #expect(await transport.writes.count == 1 && drained)
        model.resumeAfterFailedRestore()
        await model.flush()
        let writes = await transport.writes
        #expect(writes.count == 2 && writes[1].expected["value"] == writes[0].value)
        #expect(writes[1].value["defaultCurrency"] == .string("USD"))
    }
    @Test func failedRestoreNeverRebasesOrUnpoisonsARejectedSettingsQueue() async throws {
        let original: TaxValue = .object(["language": .string("en")])
        let transport = NativeSettingsFixture(values: ["app_settings": original])
        let model = settingsModel(transport)
        await model.load()
        await transport.failNextWrite(status: 503)
        model.updateApp(["language": .string("nl")])
        await model.flush()
        model.updateApp(["defaultCurrency": .string("USD")])
        await model.suspendForRestore()
        await transport.setValue("app_settings", .object(["language": .string("remote")]))
        await model.load(force: true)
        model.resumeAfterFailedRestore()
        await model.flush()
        #expect(await transport.writes.count == 1 && model.saveErrorNonce == 2)
        #expect(await model.persistence.baseline("app_settings")?["value"] == original)
        #expect(model.appValue("language") == .string("nl") && model.appValue("defaultCurrency") == .string("USD"))
    }
    @Test func realReloadRetiresPendingDraftsAndLateReadCallbacksWithoutResurrection() async throws {
        let transport = NativeSettingsFixture()
        let model = NativeSettingsModel(service: settingsClient(transport), debounce: .milliseconds(100))
        await model.load()
        var changes = 0
        var acknowledgments = 0
        var notices = 0
        model.didChangeApp = { _ in changes += 1 }
        model.didAcknowledge = { _, _ in acknowledgments += 1 }
        model.didNotice = { _ in notices += 1 }
        await transport.gateNextRead()
        await transport.setCategory(
            .init(
                id: 99, name: "Old DB", pathIds: [99], path: ["Old DB"], categoryName: "Old DB", depth: 0,
                isActive: true, hierarchyOnly: false, legacyCompatible: true))
        await transport.gateNextCategoryRead()
        let read = Task { await model.load(force: true) }
        let categoryRead = Task { await model.loadCategories(force: true) }
        await waitSettings {
            let read = await transport.readIsGated
            let category = await transport.categoryIsGated
            return read && category
        }
        model.updateApp(["language": .string("nl")])
        await model.suspendForRestore()
        model.retireForReload()
        await transport.releaseRead()
        await transport.releaseCategoryRead()
        await read.value
        await categoryRead.value
        #expect(model.categories.isEmpty)
        model.resumeAfterFailedRestore()
        model.updateApp(["language": .string("en")])
        await model.flush()
        #expect(model.isSuspendedForRestore && changes == 1 && acknowledgments == 0 && notices == 0)
        #expect(await transport.writes.isEmpty)
        await #expect(throws: CancellationError.self) {
            try await model.persistence.save("app_settings", value: .object([:]))
        }
    }
    @Test func restoreDrainIncludesImmediateWritesAndTheirAcknowledgedAuthority() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        await transport.gateNextWrite()
        var invalidations = 0
        model.didChangeIncludeTransfers = { invalidations += 1 }
        let toggle = Task { await model.setIncludeTransfers(true) }
        await waitSettings { await transport.writeIsGated }
        var drained = false
        let suspension = Task {
            await model.suspendForRestore()
            drained = true
        }
        await waitSettings { model.isSuspendedForRestore }
        #expect(!drained)
        await transport.releaseWrite()
        await suspension.value
        await toggle.value
        #expect(drained && invalidations == 1)
        model.resumeAfterFailedRestore()
        await model.setIncludeTransfers(false)
        let writes = await transport.writes
        #expect(writes.count == 2 && writes[1].expected == .object(["exists": .bool(true), "value": .bool(true)]))
    }
    @Test func repeatedSuspendAndPermanentRetirementKeepTheFenceClosed() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        await model.load()
        await transport.gateNextWrite()
        // Cost basis also schedules an app-envelope debounce; its second accepted write
        // would make this one-write lifecycle assertion depend on scheduler timing.
        let edit = Task { await model.setIncludeTransfers(true) }
        await waitSettings { await transport.writeIsGated }
        var suspensionsStarted = 0
        var suspensionsFinished = 0
        let first = Task {
            suspensionsStarted += 1
            await model.suspendForRestore()
            suspensionsFinished += 1
        }
        let second = Task {
            suspensionsStarted += 1
            await model.suspendForRestore()
            suspensionsFinished += 1
        }
        await waitSettings { model.isSuspendedForRestore && suspensionsStarted == 2 }
        #expect(suspensionsFinished == 0)
        await model.setIncludeTransfers(false)
        #expect(model.includeTransfers)
        await transport.releaseWrite()
        await edit.value
        await first.value
        await second.value
        #expect(suspensionsFinished == 2)
        model.retireForReload()
        model.retireForReload()
        model.resumeAfterFailedRestore()
        await model.flush()
        #expect(await transport.writes.count == 1 && model.isSuspendedForRestore)
        await #expect(throws: CancellationError.self) {
            try await model.persistence.save("includeTransfers", value: .bool(false))
        }
    }
    @Test func hostServicesFailureRollsBackWithoutWritingAppEnvelope() async throws {
        let transport = NativeSettingsFixture()
        let model = settingsModel(transport)
        model.loadKeepServices = { true }
        model.saveKeepServices = { _ in throw SettingsWriteError("fixture") }
        await model.load()
        await model.loadServices()
        #expect(model.supportsServices && model.keepServicesOnQuit)
        await model.setKeepServicesOnQuit(false)
        #expect(model.keepServicesOnQuit && model.notice?.key == "settings.saveFailed")
        #expect(await transport.writes.isEmpty)
    }
}

private func settingsClient(_ transport: NativeSettingsFixture) -> APIClient {
    APIClient(
        baseURL: { URL(string: "http://fixture.invalid")! }, transport: transport,
        sleep: { _ in }, jitter: { 0 }, maxRetries: 2)
}
@MainActor private func settingsModel(_ transport: NativeSettingsFixture) -> NativeSettingsModel {
    .init(service: settingsClient(transport), debounce: .milliseconds(10))
}
@MainActor private func waitSettings(_ predicate: () async -> Bool) async {
    for _ in 0..<1000 {
        if await predicate() { return }
        try? await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("Fixture did not reach its controlled suspension")
}
private actor NativeSettingsFixture: APITransport {
    struct Write: Sendable {
        let key: String
        let value: TaxValue
        let expected: TaxValue
    }
    private var values: [String: TaxValue]
    private(set) var requests: [APIRequest] = []
    private(set) var writes: [Write] = []
    private var failure: Int?
    private var gateWrite = false
    private var gateRead = false
    private var gateCategory = false
    private var categories: [OpenAPI.CategoryNode] = []
    private var categoryContinuation: CheckedContinuation<Void, Never>?
    private var writeContinuation: CheckedContinuation<Void, Never>?
    private var readContinuation: CheckedContinuation<Void, Never>?
    var writeIsGated: Bool { writeContinuation != nil }
    var readIsGated: Bool { readContinuation != nil }
    var categoryIsGated: Bool { categoryContinuation != nil }
    init(values: [String: TaxValue] = [:]) { self.values = values }
    func failNextWrite(status: Int) { failure = status }
    func gateNextWrite() { gateWrite = true }
    func gateNextRead() { gateRead = true }
    func gateNextCategoryRead() { gateCategory = true }
    func setCategory(_ category: OpenAPI.CategoryNode) { categories = [category] }
    func releaseCategoryRead() {
        categoryContinuation?.resume()
        categoryContinuation = nil
    }
    func releaseWrite() {
        writeContinuation?.resume()
        writeContinuation = nil
    }
    func releaseRead() {
        readContinuation?.resume()
        readContinuation = nil
    }
    func setValue(_ key: String, _ value: TaxValue) { values[key] = value }
    func value(_ key: String) -> TaxValue? { values[key] }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let path = request.url.path
        if path == "/api/settings", request.method == .get {
            let captured = values
            if gateRead {
                gateRead = false
                await withCheckedContinuation { readContinuation = $0 }
            }
            return try response(
                .object([
                    "settings": .object(captured),
                    "expected": .object(captured.mapValues { .object(["exists": .bool(true), "value": $0]) }),
                ]))
        }
        if path.hasPrefix("/api/settings/") {
            let key = String(path.dropFirst("/api/settings/".count))
            if request.method == .get { return try response(record(key)) }
            let body = try JSONDecoder().decode(TaxValue.self, from: request.body!)
            let value = body["value"]!
            let expected = body["expected"]!
            writes.append(.init(key: key, value: value, expected: expected))
            if gateWrite {
                gateWrite = false
                await withCheckedContinuation { writeContinuation = $0 }
            }
            if let failure {
                self.failure = nil
                return try error(status: failure)
            }
            guard expected == baseline(key) else { return try error(status: 409) }
            values[key] = value
            return try response(record(key))
        }
        if path == "/api/categories/tree" {
            let captured = categories
            if gateCategory {
                gateCategory = false
                await withCheckedContinuation { categoryContinuation = $0 }
            }
            return try response(
                .object([
                    "items": .array(try captured.map { try TaxValue(encoding: $0) }),
                    "total": .number(Decimal(captured.count)),
                ]))
        }
        if path == "/api/recipients" {
            return try response(
                .object([
                    "items": .array([]), "total": .number(0), "limit": .number(1000), "offset": .number(0),
                    "links": .array([]),
                ]))
        }
        throw APIError.invalidRequest("Unexpected fixture path")
    }
    private func baseline(_ key: String) -> TaxValue {
        if let value = values[key] { return .object(["exists": .bool(true), "value": value]) }
        return .object(["exists": .bool(false)])
    }
    private func record(_ key: String) -> TaxValue {
        .object(["key": .string(key), "value": values[key] ?? .null, "expected": baseline(key)])
    }
    private func response(_ value: TaxValue) throws -> APIResponse {
        .init(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": value])))
    }
    private func error(status: Int) throws -> APIResponse {
        .init(
            status: status,
            body: try APIBody.encode(
                TaxValue.object([
                    "ok": .bool(false),
                    "error": .object([
                        "code": .string(status == 409 ? "CONFLICT" : "SERVICE_UNAVAILABLE"),
                        "message": .string("Fixture rejection"),
                    ]),
                ])))
    }
}

@MainActor private final class NativeSettingsFixtureClock {
    var value: Date
    init(_ value: Date) { self.value = value }
}
