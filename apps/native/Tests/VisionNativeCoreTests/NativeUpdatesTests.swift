import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct ReleaseVersionTests {
    @Test func normalizesTags() {
        #expect(ReleaseVersion.normalizeTag("2.1.0") == "v2.1.0")
        #expect(ReleaseVersion.normalizeTag(" v2.1.0 ") == "v2.1.0")
        #expect(ReleaseVersion.normalizeTag(nil) == "")
        #expect(ReleaseVersion.normalizeTag("") == "")
    }

    @Test func comparesCoresAndPreReleases() {
        #expect(ReleaseVersion.compare("v2.1.0", "v2.0.9") == 1)
        #expect(ReleaseVersion.compare("v2.1", "v2.1.0") == 0)
        #expect(ReleaseVersion.compare("v2.1.0-beta.1", "v2.1.0") == -1)
        #expect(ReleaseVersion.compare("v2.1.0-alpha.2", "v2.1.0-alpha.10") == -1)
        #expect(ReleaseVersion.compare("v2.1.0-1", "v2.1.0-alpha") == -1)
        #expect(ReleaseVersion.compare("v2.1.0-alpha", "v2.1.0-alpha.1") == -1)
    }
}

/// The cases of apps/frontend/src/lib/releaseNotes.test.ts.
@Suite struct ReleaseNotesTests {
    @Test func reducesAGeneratedReleaseBody() {
        let body = [
            "<!-- Release notes generated using configuration in .github/release.yml -->",
            "## What's Changed",
            "* fix(frontend): keep **chart** range by @EraPartner in https://github.com/EraPartner/Vision/pull/390",
            "* chore(deps): bump `electron` by @dependabot[bot] in https://github.com/EraPartner/Vision/pull/47",
            "",
            "**Full Changelog**: https://github.com/EraPartner/Vision/compare/v2.0.0...v2.0.1",
        ].joined(separator: "\n")
        #expect(
            ReleaseNotes.summary(body)
                == "fix(frontend): keep chart range by @EraPartner · chore(deps): bump electron by @dependabot[bot]")
    }

    @Test func keepsLinkTextAndProse() {
        #expect(
            ReleaseNotes.summary("> Faster _imports_ and [new charts](https://example.com/x).\r\n1. Backup fix")
                == "Faster imports and new charts. · Backup fix")
    }

    @Test func emptyWhenOnlyHeadingsOrLabelsRemain() {
        #expect(ReleaseNotes.summary("## Notes\n\n**Full Changelog**: https://x.y") == "")
    }
}

@Suite struct NativeUpdateCheckerTests {
    private static func release(_ tag: String?) -> JSONValue {
        var object: [String: JSONValue] = [
            "html_url": .string("https://github.com/EraPartner/Vision/releases/tag/v2.2.0"),
            "body": .string("## What's Changed\n* feat: faster"),
            "published_at": .string("2026-11-06T10:00:00Z"),
        ]
        if let tag { object["tag_name"] = .string(tag) }
        return .object(object)
    }

    @Test func demoIsUpToDateWithoutFetching() async throws {
        let checker = NativeUpdateChecker(currentVersion: "2.1.0", isDemo: true) {
            Issue.record("Demo must not fetch")
            return .null
        }
        let status = try await checker.check()
        #expect(status.upToDate)
        #expect(status.currentVersion == "v2.1.0")
        #expect(status.latestVersion == nil)
    }

    @Test func newerReleaseIsAnUpdate() async throws {
        let checker = NativeUpdateChecker(currentVersion: "2.1.0", isDemo: false) { Self.release("v2.2.0") }
        let status = try await checker.check()
        #expect(!status.upToDate)
        #expect(status.latestVersion == "v2.2.0")
        #expect(status.releaseSummary == "feat: faster")
        #expect(status.releaseNotesURL?.absoluteString == "https://github.com/EraPartner/Vision/releases/tag/v2.2.0")
        #expect(status.mode == .source)
    }

    @Test func missingTagIsAnError() async throws {
        let checker = NativeUpdateChecker(currentVersion: "2.1.0", isDemo: false) { Self.release(nil) }
        let status = try await checker.check()
        #expect(status.upToDate)
        #expect(status.error == "Could not determine latest release version.")
    }

    @Test func releasePageOpensOnlyGitHub() {
        #expect(
            NativeUpdateChecker.releasePage("https://github.com/EraPartner/Vision/releases/tag/v2.2.0").absoluteString
                == "https://github.com/EraPartner/Vision/releases/tag/v2.2.0")
        #expect(NativeUpdateChecker.releasePage("https://evil.example/x") == NativeUpdateChecker.releasesPage)
        #expect(NativeUpdateChecker.releasePage(nil) == NativeUpdateChecker.releasesPage)
    }
}

@MainActor @Suite struct NativeUpdateModelTests {
    @Test func applyBacksUpThenOpensTheReleasePage() async {
        let model = NativeUpdateModel(
            checker: NativeUpdateChecker(currentVersion: "2.1.0", isDemo: false) {
                .object(["tag_name": .string("v2.2.0"), "html_url": .string("https://github.com/EraPartner/Vision")])
            })
        var opened: [URL] = []
        var notices: [String] = []
        var backups = 0
        model.openURL = { opened.append($0) }
        model.didNotice = { notices.append($0.key) }
        model.preUpdateBackup = {
            backups += 1
            return NativePreUpdateBackupResult(success: true)
        }
        await model.checkNow()
        #expect(model.isUpdateReady)
        await model.apply()
        #expect(backups == 1)
        #expect(opened.map(\.absoluteString) == ["https://github.com/EraPartner/Vision"])
        #expect(notices == ["settings.app.updateAvailable", "update.manualDownload"])
        #expect(model.applyPhase == .idle)
    }

    @Test func failedBackupStopsTheInstall() async {
        let model = NativeUpdateModel(
            checker: NativeUpdateChecker(currentVersion: "2.1.0", isDemo: false) {
                .object(["tag_name": .string("v2.2.0")])
            })
        var opened = 0
        var notices: [String] = []
        model.openURL = { _ in opened += 1 }
        model.didNotice = { notices.append($0.key) }
        model.preUpdateBackup = { NativePreUpdateBackupResult(success: false, error: "disk full") }
        await model.apply()
        #expect(opened == 0)
        #expect(notices == ["update.backupFailed"])
    }
}
