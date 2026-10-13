import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Analysis SQL history factory bridge integration")
struct AnalysisSQLHistoryIntegrationTests {
    @Test func actualClosureFactoryKeepsMetadataAcrossNativeRouteVisits() async throws {
        var persisted = try APIBody.encode(["SELECT synthetic_history"])
        let store = AnalysisClosureSQLHistoryStore(read: { persisted }, write: { persisted = $0 })
        let queries = (0..<12).map { "SELECT synthetic_\($0)" }
        await store.write(queries)
        #expect(try JSONDecoder().decode([String].self, from: persisted) == Array(queries.prefix(10)))
        let client = APIClient(baseURL: { nil }, maxRetries: 0)
        let screens = AnalysisScreens(client: client, sqlRead: { persisted }, sqlWrite: { persisted = $0 })
        let shell = NativeShellModelTests().makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(), analysis: screens)
        let route = try #require(NativeRoute("/analysis?savedAnalysis=invalid"))
        shell.routeDidChange(route)
        await shell.settingsSettled()
        #expect(shell.detail == .native(.analysis))
        await screens.didAppear(route: route)
        #expect(screens.workspace.sqlHistory == Array(queries.prefix(10)))
        screens.workspace.name = "Unsaved synthetic draft"
        screens.didDisappear()
        #expect(screens.workspace.name.isEmpty)
        let returning = AnalysisScreens(client: client, sqlRead: { persisted }, sqlWrite: { persisted = $0 })
        await returning.didAppear()
        #expect(returning.workspace.sqlHistory == Array(queries.prefix(10)))
        #expect(returning.workspace.name.isEmpty)
        returning.didDisappear()
    }
}
