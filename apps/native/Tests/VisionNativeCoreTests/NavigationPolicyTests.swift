import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct NavigationPolicyTests {
    let app = URL(string: "http://localhost:36962")!

    private func url(_ text: String) -> URL { URL(string: text)! }

    @Test func appOriginIsSchemeHostAndPortWithoutCredentials() {
        #expect(NavigationPolicy.isAppURL(url("http://localhost:36962/analysis?q=1"), appURL: app))
        #expect(NavigationPolicy.isAppURL(url("http://LOCALHOST:36962/"), appURL: app))
        for candidate in [
            "http://localhost:3002/",
            "http://127.0.0.1:36962/",
            "http://localhost.evil.test:36962/",
            "http://user:pass@localhost:36962/",
            "https://localhost:36962/",
            "file:///Applications/Vision%20Native.app/Contents/Resources/runtime/manifest.json",
            "https://example.com/",
            "data:text/html,hello",
        ] {
            #expect(!NavigationPolicy.isAppURL(url(candidate), appURL: app), "\(candidate)")
        }
    }

    @Test func defaultPortsCompareEqual() {
        #expect(NavigationPolicy.isAppURL(url("http://localhost/x"), appURL: url("http://localhost:80")))
        #expect(!NavigationPolicy.isAppURL(url("http://localhost:8080/x"), appURL: url("http://localhost")))
    }

    @Test func navigationStaysOnTheBackendOrigin() {
        #expect(
            NavigationPolicy.decideNavigation(
                url: url("http://localhost:36962/transactions"), isMainFrame: true, shouldPerformDownload: false,
                appURL: app) == .allow)
        #expect(
            NavigationPolicy.decideNavigation(
                url: url("http://localhost:3002/"), isMainFrame: true, shouldPerformDownload: false, appURL: app)
                == .cancel("navigation to an untrusted URL"))
        #expect(
            NavigationPolicy.decideNavigation(url: nil, isMainFrame: true, shouldPerformDownload: false, appURL: app)
                == .cancel("navigation without a URL"))
    }

    @Test func trustedExternalLinksOpenInTheBrowser() {
        let repository = url(ShellLinks.repository)
        #expect(
            NavigationPolicy.decideNavigation(
                url: repository, isMainFrame: true, shouldPerformDownload: false, appURL: app)
                == .openExternally(repository))
        #expect(NavigationPolicy.decideNewWindow(url: url(ShellLinks.documentation)) == .openExternally(url(ShellLinks.documentation)))
        // Exact strings only, like openTrustedExternalUrl.
        #expect(NavigationPolicy.decideNewWindow(url: url(ShellLinks.repository + "/issues")) != .openExternally(url(ShellLinks.repository + "/issues")))
        #expect(NavigationPolicy.decideNewWindow(url: url("http://localhost:36962/api/attachments/1")) == .cancel("new window for an untrusted URL"))
        #expect(NavigationPolicy.decideNewWindow(url: nil) == .cancel("new window for an untrusted URL"))
    }

    @Test func blankSubframesLoadButABlankMainFrameDoesNot() {
        #expect(
            NavigationPolicy.decideNavigation(
                url: url("about:blank"), isMainFrame: false, shouldPerformDownload: false, appURL: app) == .allow)
        #expect(
            NavigationPolicy.decideNavigation(
                url: url("about:blank"), isMainFrame: true, shouldPerformDownload: false, appURL: app)
                == .cancel("navigation to an untrusted URL"))
    }

    @Test func downloadsComeFromTheAppOrThePageOnly() {
        for candidate in [
            "blob:http://localhost:36962/4f6c2b1e-1111-2222-3333-444455556666",
            "data:text/csv;charset=utf-8,a%2Cb",
            "http://localhost:36962/api/export/transactions.csv",
        ] {
            #expect(
                NavigationPolicy.decideNavigation(
                    url: url(candidate), isMainFrame: true, shouldPerformDownload: true, appURL: app) == .download,
                "\(candidate)")
        }
        for candidate in ["blob:https://example.com/abc", "https://example.com/file.pdf"] {
            #expect(
                NavigationPolicy.decideNavigation(
                    url: url(candidate), isMainFrame: true, shouldPerformDownload: true, appURL: app)
                    == .cancel("download from an untrusted origin"), "\(candidate)")
        }
    }

    @Test func attachmentsAndUnshowableResponsesBecomeDownloads() {
        let export = url("http://localhost:36962/api/reports/tax.pdf")
        #expect(
            NavigationPolicy.decideResponse(
                url: export, canShowMIMEType: true, contentDisposition: "attachment; filename=\"tax.pdf\"",
                appURL: app) == .download)
        #expect(
            NavigationPolicy.decideResponse(url: export, canShowMIMEType: false, contentDisposition: nil, appURL: app)
                == .download)
        #expect(
            NavigationPolicy.decideResponse(url: export, canShowMIMEType: true, contentDisposition: "inline", appURL: app)
                == .allow)
        #expect(
            NavigationPolicy.decideResponse(
                url: url("https://example.com/x.zip"), canShowMIMEType: false, contentDisposition: nil, appURL: app)
                == .cancel("download from an untrusted origin"))
    }

    @Test func downloadFilenamesAreSingleComponents() {
        #expect(NavigationPolicy.downloadFilename("transactions-2026.csv") == "transactions-2026.csv")
        #expect(NavigationPolicy.downloadFilename("../../etc/passwd") == "passwd")
        #expect(NavigationPolicy.downloadFilename("report:final.pdf") == "report-final.pdf")
        #expect(NavigationPolicy.downloadFilename("  ") == "download")
        #expect(NavigationPolicy.downloadFilename("..") == "download")
    }
}
