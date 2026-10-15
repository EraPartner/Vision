import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Optional native cold actions and menus")
struct NativeShellIntentIntegrationTests {
    private func makeModel(
        session: NativeShellIntentCoordinator? = nil, initial: String = "/planned",
        loaded: Bool = false, documentReady: Bool = false,
        nativeSettings: NativeSettingsModel? = nil, recorder: ShellRecorder
    ) -> NativeShellModel {
        let model = NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]),
            theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(), planned: PlannedFixture.idleModel(),
            imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            nativeSettings: nativeSettings, nativeFallback: true,
            nativeNavigation: NativeNavigationHistory(initial: NativeNavigationLocation(initial)!),
            nativeIntents: session, loadSettings: { .defaults },
            onNavigate: { recorder.actions.append($0) })
        model.isRendererReady = documentReady
        if loaded { model.apply(settings: .defaults) }
        return model
    }

    private func file(_ name: String = "cold.csv") -> ImportFile {
        ImportFile(name: name, data: Data("date,amount\n2026-01-01,1".utf8))
    }

    @Test func coldCSVWaitsForHydrationOnboardingAndAReadyDestination() async {
        let session = NativeShellIntentCoordinator()
        let recorder = ShellRecorder()
        let model = makeModel(session: session, recorder: recorder)
        let csv = file()
        model.isPresentingOnboarding = true
        #expect(model.openImportFile(csv))
        #expect(model.route.path == "/planned" && model.imports.file == nil)
        model.apply(settings: .defaults)
        model.isRendererReady = true
        model.nativeIntentReadinessDidChange()
        #expect(model.route.path == "/planned" && model.imports.file == nil)
        model.isPresentingOnboarding = false
        model.nativeIntentReadinessDidChange()
        #expect(model.route.path == "/import" && model.imports.file == nil)
        model.nativeIntentConsumerDidBecomeReady(for: .transactions)
        #expect(model.imports.file == nil && !model.transactions.isAddPresented)
        model.nativeIntentConsumerDidBecomeReady(for: .importExport)
        #expect(model.imports.file == csv && recorder.actions.isEmpty)
        model.nativeIntentReadinessDidChange()
        #expect(model.imports.file == csv)
        await model.settingsSettled()
    }

    @Test func coldTransactionSurvivesRebuildAndOldGraphCannotConsumeOrOverwriteHistory() async {
        let session = NativeShellIntentCoordinator()
        let recorder = ShellRecorder()
        let first = makeModel(
            session: session, initial: "/transactions?q=a+b&flag&raw=%2f", loaded: true,
            documentReady: true, recorder: recorder)
        first.navigate(to: "/planned?year=2024")
        first.isReloadingGraph = true
        #expect(first.newTransaction())
        let second = makeModel(session: session, recorder: recorder)
        #expect(second.nativeNavigationLocation?.raw == "/planned?year=2024" && second.canGoBack)
        #expect(!first.newTransaction() && !first.openImportFile(file("stale.csv")))
        first.isReloadingGraph = false
        first.nativeIntentReadinessDidChange()
        first.nativeIntentConsumerDidBecomeReady(for: .transactions)
        first.goBack()
        #expect(!first.transactions.isAddPresented && second.route.path == "/planned")
        second.apply(settings: .defaults)
        second.isRendererReady = true
        second.nativeIntentReadinessDidChange()
        #expect(second.route.path == "/transactions" && !second.transactions.isAddPresented)
        second.nativeIntentConsumerDidBecomeReady(for: .transactions)
        #expect(second.transactions.isAddPresented && recorder.actions.isEmpty)
        let third = makeModel(session: session, loaded: true, documentReady: true, recorder: recorder)
        third.nativeIntentConsumerDidBecomeReady(for: .transactions)
        #expect(!third.transactions.isAddPresented && third.route.path == "/transactions")
        third.goBack()
        third.goBack()
        #expect(third.nativeNavigationLocation?.raw == "/transactions?q=a+b&flag&raw=%2f")
        await first.settingsSettled()
        await second.settingsSettled()
        await third.settingsSettled()
    }

    @Test func registeredCSVExpiryIsNotRestartedByGraphReplacement() async {
        var clock = Date(timeIntervalSince1970: 1_000)
        let session = NativeShellIntentCoordinator(now: { clock })
        let recorder = ShellRecorder()
        let first = makeModel(session: session, loaded: true, documentReady: true, recorder: recorder)
        #expect(first.openImportFile(file()))
        #expect(first.route.path == "/import" && first.imports.file == nil)
        clock.addTimeInterval(31)
        let second = makeModel(session: session, loaded: true, documentReady: true, recorder: recorder)
        second.nativeIntentConsumerDidBecomeReady(for: .importExport)
        #expect(second.imports.file == nil && second.route.path == "/import")
        await first.settingsSettled()
        await second.settingsSettled()
    }

    @Test func blockedColdTransactionKeepsItsDestinationAcrossReconstruction() async {
        let session = NativeShellIntentCoordinator()
        let recorder = ShellRecorder()
        let first = makeModel(session: session, loaded: true, documentReady: true, recorder: recorder)
        first.setLeaveGuard(.init(id: "/planned", hasUnsavedChanges: { true }, discard: {}))
        #expect(first.newTransaction())
        #expect(first.route.path == "/planned" && first.leaveConfirmation?.path == "/transactions")
        let second = makeModel(session: session, loaded: true, documentReady: true, recorder: recorder)
        #expect(second.leaveConfirmation == nil && second.route.path == "/planned")
        second.nativeIntentReadinessDidChange()
        second.nativeIntentConsumerDidBecomeReady(for: .transactions)
        #expect(second.route.path == "/transactions" && second.transactions.isAddPresented)
        #expect(recorder.actions.isEmpty)
        await first.settingsSettled()
        await second.settingsSettled()
    }

    @Test func stayCancelsThePendingSheetAndRepeatedReadyCommandsReuseItsForm() async throws {
        let session = NativeShellIntentCoordinator()
        let recorder = ShellRecorder()
        let model = makeModel(session: session, loaded: true, documentReady: true, recorder: recorder)
        model.setLeaveGuard(.init(id: "/planned", hasUnsavedChanges: { true }, discard: {}))
        #expect(model.newTransaction())
        model.stayOnPage()
        model.removeLeaveGuard(id: "/planned")
        model.navigate(to: "/transactions")
        model.nativeIntentConsumerDidBecomeReady(for: .transactions)
        #expect(!model.transactions.isAddPresented)
        #expect(model.newTransaction())
        let form = try #require(model.transactions.addForm)
        #expect(model.transactions.isAddPresented)
        #expect(model.newTransaction())
        #expect(model.transactions.addForm === form && model.transactions.isAddPresented)
        await model.settingsSettled()
    }

    @Test func settingsAndThemeMenusUseHydratedNativeOwnersWithoutRendererMessages() async {
        let service = NativeIntentSettingsService()
        let settings = NativeSettingsModel(service: service, debounce: .zero)
        let recorder = ShellRecorder()
        let model = makeModel(
            session: NativeShellIntentCoordinator(), loaded: true, documentReady: true,
            nativeSettings: settings, recorder: recorder)
        #expect(model.acceptNativeMenuAction(.openSettings))
        #expect(model.acceptNativeMenuAction(.setTheme("dark")))
        #expect(model.acceptNativeMenuAction(.setTheme("neon")))
        #expect(model.route.value("settings") == nil && settings.themeRaw == nil)
        await settings.load()
        model.nativeIntentReadinessDidChange()
        #expect(model.settingsSection == "general" && model.isPresentingNativeSettings)
        #expect(settings.themeString("mode", fallback: "invalid") == "dark")
        #expect(settings.themeRaw?["variant"] == .string("nord"))
        #expect(settings.themeRaw?["schedule"]?["darkFrom"] == .string("21:15"))
        #expect(model.acceptNativeMenuAction(.closeSettings))
        #expect(model.settingsSection == nil && !model.canGoBack)
        #expect(!model.acceptNativeMenuAction(MenuAction("unknown")))
        #expect(recorder.actions.isEmpty)
        await settings.flush()
        #expect(await service.writes.count == 1)
        await model.settingsSettled()
    }

    @Test func omissionPreservesExistingColdActionAndMenuFallbackBehavior() async {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        #expect(!model.newTransaction())
        #expect(!model.openImportFile(file()))
        #expect(!model.acceptNativeMenuAction(.openSettings))
        model.apply(settings: .defaults)
        model.nativeIntentReadinessDidChange()
        model.nativeIntentConsumerDidBecomeReady(for: .importExport)
        #expect(model.route.path == "/planned" && recorder.actions.isEmpty)
        await model.settingsSettled()
    }
}

private actor NativeIntentSettingsService: NativeSettingsService {
    private let theme: TaxValue = .object([
        "mode": .string("light"), "variant": .string("nord"), "systemAccent": .bool(true),
        "schedule": .object(["darkFrom": .string("21:15"), "lightFrom": .string("07:30")]),
    ])
    private(set) var writes: [NativeSettingsRecord] = []

    func readNativeSettings() async throws -> NativeSettingsSnapshot {
        .init(
            settings: ["theme_settings": theme],
            expected: ["theme_settings": .object(["exists": .bool(true), "value": theme])])
    }
    func readNativeSetting(_ key: String) async throws -> NativeSettingsRecord {
        .init(key: key, value: theme, expected: .object(["exists": .bool(true), "value": theme]))
    }
    func saveNativeSetting(_ key: String, value: TaxValue, expected: TaxValue) async throws
        -> NativeSettingsRecord
    {
        let record = NativeSettingsRecord(
            key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
        writes.append(record)
        return record
    }
    func nativeSettingsCategories() async throws -> [OpenAPI.CategoryNode] { [] }
    func nativeSettingsRecipients() async throws -> [OpenAPI.Recipient] { [] }
}
