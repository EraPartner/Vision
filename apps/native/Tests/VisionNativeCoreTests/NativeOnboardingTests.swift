import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native onboarding source steps, receipts and draft authority")
struct NativeOnboardingTests {
    @Test func draftStrictlyMatchesV1AndFiltersStaleIndexes() throws {
        var draft = NativeOnboardingDraft()
        draft.step = .importData
        draft.selectedBank = "  fixture  "
        draft.selectedCategoryIndexes = [2, 2, 99, 0]
        draft.reviewBatch = .init(batchId: 72, rows: 8)
        let data = try draft.encoded()
        let raw = try JSONDecoder().decode(TaxValue.self, from: data)
        #expect(raw["importResult"] == .null)
        let restored = NativeOnboardingDraft.read(data)
        #expect(restored.selectedCategoryIndexes == [0, 2])
        #expect(restored.selectedBank == "fixture")
        #expect(restored.reviewBatch?.batchId == 72)
        var invalid = raw.objectValue!
        invalid["future"] = .bool(true)
        #expect(NativeOnboardingDraft.read(try JSONEncoder().encode(TaxValue.object(invalid))) == .init())
        invalid.removeValue(forKey: "future")
        invalid["reviewBatch"] = .object(["batchId": .number(0), "rows": .number(8)])
        #expect(NativeOnboardingDraft.read(try JSONEncoder().encode(TaxValue.object(invalid))) == .init())
    }
    @Test func bankMonogramsUseSourceWordsAndAdapterKeyFallback() {
        #expect(NativeOnboardingPreset.bankMonogram(name: "KBC Bank", key: "kbc") == "KB")
        #expect(NativeOnboardingPreset.bankMonogram(name: "A Bank", key: "a") == "AB")
        #expect(NativeOnboardingPreset.bankMonogram(name: "…", key: "test-key") == "Te")
        #expect(NativeOnboardingPreset.bankMonogram(name: "", key: "---") == "?")
    }
    @Test func malformedDraftAndUnsafeCountsFallBackWithoutTruncation() throws {
        #expect(NativeOnboardingDraft.read(Data("not json".utf8)) == .init())
        #expect(NativeOnboardingDraft.safeCount(.number(1.5)) == nil)
        #expect(NativeOnboardingDraft.safeCount(.number(9_007_199_254_740_992)) == nil)
        #expect(NativeOnboardingDraft.safeCount(.number(9_007_199_254_740_991)) == 9_007_199_254_740_991)
        #expect(NativeOnboardingPreset.categories.count == 15)
        #expect(NativeOnboardingPreset.categories[11].detail == "Freelance")
    }
    @Test func adapterFailurePreservesBankUntilSuccessfulCatalogAndOutcomePreservesImportStep() async throws {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        var draft = NativeOnboardingDraft()
        draft.step = .importData
        draft.selectedBank = "removed"
        store.data = try draft.encoded()
        await fixture.failAdapters(true)
        let model = makeOnboarding(fixture, store)
        await model.load()
        #expect(model.draft.step == .importData && model.draft.selectedBank == "removed")
        await fixture.failAdapters(false)
        await model.loadAdapters()
        #expect(model.draft.step == .bank && model.draft.selectedBank.isEmpty)
        draft.reviewBatch = .init(batchId: 12, rows: 3)
        store.data = try draft.encoded()
        model.didDisappear()
        await model.begin()
        #expect(model.draft.step == .importData && model.draft.selectedBank.isEmpty)
        #expect(model.draft.reviewBatch?.batchId == 12 && model.file == nil)
    }
    @Test func allCategoryRequestsSettleAndPartialSuccessDoesNotInventRollbackOrSuccess() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        await fixture.failCategory("Rent")
        let model = makeOnboarding(fixture, store)
        var invalidations = 0
        model.didMutateCategories = { invalidations += 1 }
        await model.load()
        await model.createCategories()
        #expect(await fixture.categories.count == 15)
        #expect(!model.draft.categoriesCreated)
        #expect(model.notice?.key == "onboarding.toast.categoriesFailed" && invalidations == 1)
        await fixture.failCategory(nil)
        await model.createCategories()
        #expect(await fixture.categories.count == 30)
        #expect(model.draft.categoriesCreated && invalidations == 2)
        #expect(model.notice?.variables["n"] == "15")
    }
    @Test func firstReadAndAcknowledgedCompletionPrecedeDraftRemovalAndNavigation() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let model = makeOnboarding(fixture, store)
        await model.begin()
        await fixture.pauseSave()
        var path: String?
        model.navigate = { path = $0 }
        let completion = Task { await model.finish(path: "/transactions") }
        await fixture.waitForSave()
        #expect(model.isPresented && model.isCompleting && store.removals == 0 && path == nil)
        #expect(await fixture.settingReads == 1)
        await fixture.releaseSave()
        await completion.value
        #expect(!model.isPresented && store.removals == 1 && path == "/transactions")
        #expect(await fixture.expectedWrites == [.object(["exists": .bool(false)])])
        #expect(await fixture.value == .bool(true))
    }
    @Test func retiredSettingsReadCannotOpenAnOldWizardAfterDatabaseRestore() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let writer = NativeSettingsPersistence(service: fixture)
        await writer.retireForReload()
        let model = NativeOnboardingModel(
            service: fixture, persistence: writer, store: store, desktop: OnboardingDesktopFixture())
        await model.load()
        #expect(!model.isPresented && !model.isLoading && store.data == nil)
        #expect(await fixture.settingReads == 0)
    }
    @Test func failedCompletionKeepsDraftAndDoesNotNavigateOrReplayLostAcknowledgment() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let model = makeOnboarding(fixture, store)
        await model.load()
        await fixture.failSave(true)
        var completed = false
        model.didComplete = { completed = true }
        await model.finish(path: "/")
        #expect(model.isPresented && !model.isCompleting && !completed && store.removals == 0)
        #expect(model.notice?.key == "onboarding.persist.failed")
        await model.finish()
        #expect(await fixture.expectedWrites.count == 1)
        #expect(store.data != nil)
    }
    @Test func reviewImportPersistsStagedReceiptAndFinalButtonHandsOffToReview() async throws {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        await fixture.setImport(.init(outcome: .reviewRequired(batchId: 55), reviewRows: 9))
        let model = makeOnboarding(fixture, store)
        await model.load()
        model.selectBank("fixture")
        model.setFile(.init(name: "synthetic.csv", data: Data("date,amount\n".utf8)))
        await model.importFile()
        await model.flushDraft()
        #expect(model.draft.importResult == nil && model.draft.reviewBatch == .init(batchId: 55, rows: 9))
        #expect(model.notice?.key == "onboarding.toast.reviewRequired")
        var path: String?
        var arrived = false
        model.navigate = { path = $0 }
        model.requestDashboardArrival = { arrived = true }
        await model.finishFinalStep()
        #expect(path == "/import/55/review" && !arrived)
    }
    @Test func lateImportReceiptPublishesGloballyWithoutReopeningCompletedWizard() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let model = makeOnboarding(fixture, store)
        let notices = NativeNoticeCenter()
        model.attachNotices(notices)
        await model.load()
        model.selectBank("fixture")
        model.setFile(.init(name: "synthetic.csv", data: Data()))
        await fixture.pauseImport()
        let upload = Task { await model.importFile() }
        await fixture.waitForImport()
        await model.finish()
        await fixture.releaseImport()
        await upload.value
        #expect(!model.isPresented && store.data == nil)
        #expect(model.draft.importResult == nil)
        #expect(notices.visibleEntries.contains { $0.notice.key == "onboarding.toast.imported" })
    }
    @Test func closedToOpenReadsFreshDraftAndNeverRehydratesUploadedBytes() async throws {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let model = makeOnboarding(fixture, store)
        await model.load()
        model.next()
        await model.flushDraft()
        model.setFile(.init(name: "fixture.csv", data: Data()))
        model.didDisappear()
        var fresh = NativeOnboardingDraft()
        fresh.step = .backup
        store.data = try fresh.encoded()
        await model.begin()
        #expect(model.draft.step == .backup && model.file == nil)
        #expect(!model.importing && !model.creatingCategories && !model.isCompleting)
    }
    @Test func pickerCancellationNeverRetargetsAnEarlierRestoreSelection() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let desktop = OnboardingDesktopFixture()
        let model = makeOnboarding(fixture, store, desktop)
        await model.load()
        desktop.file = "/synthetic/first.visionbak"
        #expect(await model.selectRestoreFile() == "/synthetic/first.visionbak")
        desktop.file = nil
        #expect(await model.selectRestoreFile() == nil)
    }
    @Test func successfulRestoreUsesFreshAuthorityAndRetiredWriterDoesNotReceiveCompletion() async {
        let fixture = OnboardingFixture()
        let store = OnboardingDraftFixture()
        let desktop = OnboardingDesktopFixture()
        let writer = NativeSettingsPersistence(service: fixture)
        let model = NativeOnboardingModel(service: fixture, persistence: writer, store: store, desktop: desktop)
        await model.load()
        await writer.retireForReload()
        var freshAuthority = 0
        model.completeAfterRestore = { freshAuthority += 1 }
        await model.restore.startRestore(file: "/synthetic/restore.visionbak")
        #expect(freshAuthority == 1 && !model.isPresented && store.removals == 1)
        #expect(await fixture.expectedWrites.isEmpty)
    }
    @Test func importRequestsKeepExistingMultipartNamesAndReviewCountContract() throws {
        let request = NativeOnboardingImportRequest(
            file: .init(name: "fixture.csv", data: Data("synthetic".utf8)), bank: "fixture", boundary: "test-boundary")
        let body = String(data: try #require(request.encodedBody()), encoding: .utf8)!
        #expect(body.contains("name=\"file\"; filename=\"fixture.csv\""))
        #expect(body.contains("name=\"bank_name\"\r\n\r\nfixture"))
        #expect(!body.contains("stream"))
        let result = try TaxValue.object([
            "requires_review": .bool(true), "batch_id": .number(23),
            "match_source_counts": .object(["new": .number(4), "matched": .number(3), "missing": .null]),
        ]).decode(NativeOnboardingImportReceipt.self)
        #expect(result.outcome == .reviewRequired(batchId: 23) && result.reviewRows == 7)
    }
}

@MainActor private func makeOnboarding(
    _ fixture: OnboardingFixture, _ store: OnboardingDraftFixture,
    _ desktop: OnboardingDesktopFixture = .init()
) -> NativeOnboardingModel {
    .init(service: fixture, persistence: .init(service: fixture), store: store, desktop: desktop)
}
@MainActor private final class OnboardingDraftFixture: NativeOnboardingDraftStore {
    var data: Data?
    var removals = 0
    func read() async throws -> Data? { data }
    func write(_ value: Data) async throws { data = value }
    func remove() async throws {
        removals += 1
        data = nil
    }
}
private actor OnboardingFixture: NativeOnboardingService, NativeSettingsService {
    var categories: [NativeOnboardingCategory] = []
    var value: TaxValue = .null
    var expectedWrites: [TaxValue] = []
    var settingReads = 0
    private var adaptersFail = false
    private var categoryFail: String?
    private var saveFails = false
    private var gateSave = false
    private var saveContinuation: CheckedContinuation<Void, Never>?
    private var gateImport = false
    private var importContinuation: CheckedContinuation<Void, Never>?
    private var importReceipt = NativeOnboardingImportReceipt(
        outcome: .completed(.init(total: 4, imported: 3, duplicates: 1, errors: 0)))
    func failAdapters(_ value: Bool) { adaptersFail = value }
    func failCategory(_ value: String?) { categoryFail = value }
    func failSave(_ value: Bool) { saveFails = value }
    func setImport(_ value: NativeOnboardingImportReceipt) { importReceipt = value }
    func pauseImport() { gateImport = true }
    func waitForImport() async { while importContinuation == nil { await Task.yield() } }
    func releaseImport() {
        importContinuation?.resume()
        importContinuation = nil
    }
    func pauseSave() { gateSave = true }
    func waitForSave() async { while saveContinuation == nil { await Task.yield() } }
    func releaseSave() {
        saveContinuation?.resume()
        saveContinuation = nil
    }
    func onboardingAdapters() async throws -> [ImportAdapter] {
        if adaptersFail { throw APIError.backendUnavailable }
        return [.init(key: "fixture", name: "Synthetic bank")]
    }
    func onboardingCreateCategory(_ category: NativeOnboardingCategory) async throws {
        categories.append(category)
        if category.detail == categoryFail { throw APIError.backendUnavailable }
    }
    func onboardingImport(file: ImportFile, bank: String) async throws -> NativeOnboardingImportReceipt {
        if gateImport {
            gateImport = false
            await withCheckedContinuation { importContinuation = $0 }
        }
        return importReceipt
    }
    func readNativeSettings() async throws -> NativeSettingsSnapshot { .init(settings: [:], expected: [:]) }
    func readNativeSetting(_ key: String) async throws -> NativeSettingsRecord {
        settingReads += 1
        return .init(key: key, value: value, expected: .object(["exists": .bool(false)]))
    }
    func saveNativeSetting(_ key: String, value: TaxValue, expected: TaxValue) async throws -> NativeSettingsRecord {
        expectedWrites.append(expected)
        if gateSave {
            gateSave = false
            await withCheckedContinuation { saveContinuation = $0 }
        }
        if saveFails { throw APIError.backendUnavailable }
        self.value = value
        return .init(key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
    }
    func nativeSettingsCategories() async throws -> [OpenAPI.CategoryNode] { [] }
    func nativeSettingsRecipients() async throws -> [OpenAPI.Recipient] { [] }
}
@MainActor private final class OnboardingDesktopFixture: NativeSettingsDesktopService {
    let isAvailable = true
    var file: String?
    func loadBackupSettings() async throws -> BackupSettingsValue { .init(backupDir: "", backupOnQuit: false) }
    func saveBackupSettings(_ settings: BackupSettingsValue) async throws {}
    func selectBackupDirectory() async throws -> String? { nil }
    func selectBackupFile() async throws -> String? { file }
    func backupEncryptionStatus() async throws -> PassphraseStatus? { nil }
    func setBackupPassphrase(_ passphrase: String) async throws -> PassphraseUpdateResult? { nil }
    func captureFrontendState() async throws -> String? { nil }
    func runBackup(directory: String, frontendStateJSON: String?) async throws -> JSONValue? { nil }
    func isBackupEncrypted(path: String) async throws -> Bool { false }
    func restoreBackup(path: String, passphrase: String?) async throws -> JSONValue? {
        .object(["success": .bool(true)])
    }
    func applyRestoredFrontendState(_ state: JSONValue) async throws {}
    func reloadFrontend() async throws {}
    func readBackupReminder() async throws -> Bool { false }
    func writeBackupReminder(dismissed: Bool) async throws {}
}
