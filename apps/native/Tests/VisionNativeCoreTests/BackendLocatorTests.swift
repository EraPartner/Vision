import Foundation
import Testing
import VisionNativeCore

private let home = URL(fileURLWithPath: "/Users/demo", isDirectory: true)
private let settingsPath = "/Users/demo/Library/Application Support/Vision Demo/settings.json"

private struct MissingFile: Error {}

/// A file reader backed by an in-memory map from absolute path to contents.
private func reader(_ files: [String: String]) -> (URL) throws -> Data {
    return { url in
        guard let text = files[url.path(percentEncoded: false)] else {
            throw MissingFile()
        }
        return Data(text.utf8)
    }
}

private func locate(
    environment: [String: String] = [:],
    settings: String? = nil
) throws -> LocatedBackend? {
    var files: [String: String] = [:]
    if let settings {
        files[settingsPath] = settings
    }
    return try BackendLocator.locate(
        environment: environment,
        homeDirectory: home,
        readFile: reader(files)
    )
}

@Suite struct BackendLocatorTests {
    @Test func demoSettingsPathMatchesElectronUserData() {
        let url = BackendLocator.demoSettingsURL(homeDirectory: home)
        #expect(url.path(percentEncoded: false) == settingsPath)
    }

    @Test func environmentWinsOverDemoSettings() throws {
        let located = try locate(
            environment: [BackendLocator.environmentKey: "http://127.0.0.1:4100"],
            settings: #"{"appPort": 51234}"#
        )
        #expect(located?.source == .environment)
        #expect(located?.baseURL.absoluteString == "http://127.0.0.1:4100")
    }

    @Test func emptyEnvironmentValueFallsBackToDemoSettings() throws {
        let located = try locate(
            environment: [BackendLocator.environmentKey: ""],
            settings: #"{"appPort": 51234}"#
        )
        #expect(located?.source == .demoSettings)
    }

    @Test func demoSettingsAppPortBuildsLocalhostURL() throws {
        let located = try locate(settings: #"{"theme": "dark", "appPort": 51234}"#)
        #expect(located?.source == .demoSettings)
        #expect(located?.baseURL.absoluteString == "http://localhost:51234")
    }

    @Test func missingSettingsFileFindsNothing() throws {
        #expect(try locate() == nil)
    }

    @Test func missingAppPortKeyFindsNothing() throws {
        #expect(try locate(settings: #"{"theme": "dark"}"#) == nil)
    }

    @Test func nonIntegerOrInvalidAppPortFindsNothing() throws {
        let invalid = [
            #"{"appPort": "51234"}"#,
            #"{"appPort": 51234.5}"#,
            #"{"appPort": true}"#,
            #"{"appPort": null}"#,
            #"{"appPort": 80}"#,
            #"{"appPort": 70000}"#,
            "not json",
        ]
        for settings in invalid {
            #expect(try locate(settings: settings) == nil, "settings: \(settings)")
        }
    }

    @Test func malformedEnvironmentURLIsRejected() {
        let malformed = ["not a url", "localhost:3002", "ftp://localhost:3002", "http://", "http://localhost:3002/?a=b"]
        for raw in malformed {
            #expect(throws: BackendLocatorError.malformedEnvironmentURL(raw)) {
                try locate(
                    environment: [BackendLocator.environmentKey: raw],
                    settings: #"{"appPort": 51234}"#
                )
            }
        }
    }

    @Test func healthURLAppendsHealthPath() throws {
        let base = try #require(URL(string: "http://localhost:51234"))
        #expect(BackendHealth.healthURL(baseURL: base).absoluteString == "http://localhost:51234/health")
    }
}
