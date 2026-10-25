import Foundation
import Testing
import VisionNativeCore

@Suite struct BackendLocatorTests {
    private func decide(_ raw: String?, debug: Bool = true) -> BackendOverride {
        var environment: [String: String] = [:]
        if let raw { environment[BackendLocator.environmentKey] = raw }
        return BackendLocator.developerOverride(environment: environment, allowOverride: debug)
    }

    @Test func unsetOrEmptyOverrideMeansSupervision() {
        #expect(decide(nil) == .none)
        #expect(decide("") == .none)
    }

    @Test func debugBuildsHonourLoopbackOverrides() throws {
        for raw in ["http://127.0.0.1:4100", "http://localhost:3002", "http://[::1]:3002", "https://LOCALHOST:8443"] {
            guard case .use(let url) = decide(raw) else {
                Issue.record("expected \(raw) to be used")
                continue
            }
            #expect(url.absoluteString == raw)
        }
    }

    @Test func releaseBuildsIgnoreTheOverride() {
        guard case .ignored(let reason) = decide("http://127.0.0.1:4100", debug: false) else {
            Issue.record("Release builds must ignore the override")
            return
        }
        #expect(reason.contains("Release"))
    }

    @Test func nonLoopbackHostsAreIgnored() {
        for raw in ["http://192.168.1.10:3002", "http://vision.example:3002", "http://127.0.0.2:3002"] {
            guard case .ignored = decide(raw) else {
                Issue.record("expected \(raw) to be ignored")
                continue
            }
        }
    }

    @Test func malformedOverridesAreIgnored() {
        for raw in ["not a url", "localhost:3002", "ftp://localhost:3002", "http://", "http://localhost:3002/?a=b"] {
            guard case .ignored = decide(raw) else {
                Issue.record("expected \(raw) to be ignored")
                continue
            }
        }
    }

    @Test func healthURLAppendsHealthPath() throws {
        let base = try #require(URL(string: "http://localhost:51234"))
        #expect(BackendHealth.healthURL(baseURL: base).absoluteString == "http://localhost:51234/health")
    }
}
