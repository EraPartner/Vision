import Foundation
import Testing

@testable import VisionNativeCore

@MainActor struct ImportGlobalNoticeTests {
    @Test func capturedImportActionSurvivesLocalStackReplacementAndRunsOnce() async throws {
        let global = NativeNoticeCenter(automaticExpiry: false)
        let imports = ImportNoticeCenter()
        var route: String?
        imports.navigateTo = { route = $0 }
        imports.attachNotices(global)
        let first = imports.post(
            .success, "one", action: .init(titleKey: "open", route: "/accounts?new=1", duration: .seconds(10)))
        let entry = try #require(global.entries.first { $0.notice == first })
        #expect(global.entries.count == 1)
        #expect(entry.actionTitleKey == "open")
        #expect(!entry.isUndo)
        #expect(!global.hasUndo)
        imports.post(.success, "two")
        imports.post(.success, "three")
        imports.post(.success, "four")
        #expect(imports.action(for: first.id) == nil)
        #expect(await global.performAction(entry.id))
        #expect(route == "/accounts?new=1")
        route = nil
        #expect(!(await global.performAction(entry.id)))
        #expect(route == nil)
    }
    @Test func plainPublicationKeepsMatchingLocalClearCallback() throws {
        let global = NativeNoticeCenter(automaticExpiry: false)
        let imports = ImportNoticeCenter()
        imports.attachNotices(global)
        let first = imports.post(.success, "first")
        let firstEntry = try #require(global.entries.first { $0.notice == first })
        let second = imports.post(.error, "second")
        global.dismiss(firstEntry.id)
        #expect(imports.notices == [second])
        #expect(global.entries.map(\.notice) == [second])
    }
}
