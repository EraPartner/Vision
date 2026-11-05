import Foundation
import Testing

@testable import VisionNativeCore

@MainActor
@Suite struct PortfolioImportShellHandoffTests {
    @Test func restoredMetadataSurvivesGuardedDraftDiscardWithoutFileBytes() async throws {
        let store = PortfolioImportMemorySessionStore()
        store.values[PortfolioImportSessionModel.sessionKey] = try JSONEncoder().encode(
            TaxValue.array([
                .object([
                    "id": .string("retained-from-web"), "name": .string("statement.csv"),
                    "status": .string("staged"), "accountId": .number(42), "batchId": .number(7),
                ])
            ]))
        let service = APIClient(baseURL: { nil }, maxRetries: 0)
        let imports = PortfolioImportScreens(service: service, store: store)
        await imports.session.load()
        #expect(imports.session.ids == [7])
        #expect(imports.session.statements.first?.file == nil)
        #expect(!imports.isDirty)
        let bytes = Data("memory-only-file-content-marker".utf8)
        await imports.advanced.selectFile(
            PortfolioImportFile(filename: "pending.csv", data: bytes, contentType: "text/csv"))
        #expect(imports.advanced.file?.data == bytes && imports.isDirty)
        let shell = NativeShellModelTests().makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(),
            portfolio: PortfolioScreens(client: service), portfolioImports: imports)
        shell.show(try #require(NativeRoute("/portfolio/import")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.portfolioImport))
        shell.setLeaveGuard(
            NativeLeaveGuard(
                id: "/portfolio/import", hasUnsavedChanges: { imports.isDirty }, discard: { imports.discardDrafts() }))
        shell.navigate(to: "/portfolio/import/invalid/review")
        #expect(shell.leaveConfirmation?.path == "/portfolio/import/invalid/review")
        #expect(shell.route.path == "/portfolio/import")
        shell.leavePage()
        await imports.session.flushCheckpoint()
        #expect(shell.route.path == "/portfolio/import/invalid/review")
        #expect(imports.advanced.file == nil && !imports.isDirty)
        #expect(imports.session.ids == [7] && imports.session.statements.first?.file == nil)
        let checkpoint = try #require(store.values[PortfolioImportSessionModel.sessionKey])
        let retained = try JSONDecoder().decode([PortfolioImportStatement].self, from: checkpoint)
        #expect(retained.first?.batchId == 7 && retained.first?.file == nil)
        #expect(!String(decoding: checkpoint, as: UTF8.self).contains("memory-only-file-content-marker"))
        #expect(shell.detail == .native(.portfolioImportReview(batchId: "invalid")))
        await imports.review.load(rawBatchId: "invalid")
        #expect(imports.review.error != nil)
    }
}
