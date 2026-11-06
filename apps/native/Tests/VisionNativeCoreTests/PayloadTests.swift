import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct PayloadLocationTests {
    @Test func environmentOverrideWinsAndPointsAtTheSeedSibling() throws {
        let harness = try Harness()
        let location = try RuntimePayload.locate(
            environment: [RuntimePayload.environmentKey: testRuntimeRoot + "/"],
            resourcesDirectory: "/Applications/Vision Native.app/Contents/Resources",
            allowOverride: true, fileSystem: harness.fileSystem)
        #expect(location.source == .environment)
        #expect(location.runtimeDirectory == testRuntimeRoot)
        #expect(location.demoSeedDirectory == testSeedRoot)
    }

    @Test func relativeOrEmptyOverrideIsRejected() throws {
        let harness = try Harness()
        #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [RuntimePayload.environmentKey: "payload/native-runtime"], resourcesDirectory: nil,
                allowOverride: true, fileSystem: harness.fileSystem)
        }
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [RuntimePayload.environmentKey: "/payload/missing"], resourcesDirectory: nil,
                allowOverride: true, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "NATIVE_RUNTIME_MISSING")
    }

    @Test func appBundleResourcesAreUsedWithoutAnOverride() throws {
        let fileSystem = FakeFileSystem()
        let resources = "/Applications/Vision Native.app/Contents/Resources"
        fileSystem.addFile("\(resources)/runtime/manifest.json", #"{"version":1,"entries":[]}"#)
        let location = try RuntimePayload.locate(
            environment: [:], resourcesDirectory: resources, allowOverride: true, fileSystem: fileSystem)
        #expect(location.source == .appBundle)
        #expect(location.runtimeDirectory == "\(resources)/runtime")
        #expect(location.demoSeedDirectory == "\(resources)/demo-seed")
    }

    @Test func releaseBuildsIgnoreTheOverride() throws {
        let harness = try Harness()
        let resources = "/Applications/Vision Native.app/Contents/Resources"
        harness.fileSystem.addFile("\(resources)/runtime/manifest.json", #"{"version":1,"entries":[]}"#)
        let location = try RuntimePayload.locate(
            environment: [RuntimePayload.environmentKey: testRuntimeRoot], resourcesDirectory: resources,
            allowOverride: false, fileSystem: harness.fileSystem)
        #expect(location.source == .appBundle)
        #expect(location.runtimeDirectory == "\(resources)/runtime")

        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [RuntimePayload.environmentKey: testRuntimeRoot], resourcesDirectory: nil,
                allowOverride: false, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "NATIVE_RUNTIME_MISSING")
    }

    @Test func missingPayloadGivesAnActionableError() {
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [:], resourcesDirectory: "/Applications/Vision Native.app/Contents/Resources",
                allowOverride: true, fileSystem: FakeFileSystem())
        }
        #expect(error?.code == "NATIVE_RUNTIME_MISSING")
        #expect(error?.message.contains("install-native.sh") == true)
        #expect(error?.message.contains(RuntimePayload.environmentKey) == true)
    }
}

@Suite struct ManifestVerificationTests {
    @Test func preparedPayloadVerifies() throws {
        let harness = try Harness()
        let count = try RuntimePayload.verifyManifest(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        #expect(count >= 6)
    }

    @Test func modifiedFileFailsChecksum() throws {
        let harness = try Harness()
        harness.fileSystem.addFile("\(testRuntimeRoot)/vision-backend", "tampered", mode: 0o755)
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifest(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "NATIVE_RUNTIME_CORRUPT")
        #expect(error?.message.contains("vision-backend") == true)
    }

    @Test func unlistedFileIsRejected() throws {
        let harness = try Harness()
        harness.fileSystem.addFile("\(testRuntimeRoot)/tools/extra.js", "x")
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifest(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        }
        #expect(error?.message.contains("not covered") == true)
    }

    @Test func symlinkInPayloadIsRejected() throws {
        let harness = try Harness()
        harness.fileSystem.addNode("\(testRuntimeRoot)/link", .symlink("/etc/passwd"))
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifest(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        }
        #expect(error?.message.contains("unsupported entry") == true)
    }

    @Test func traversalEntryIsRejected() throws {
        let fileSystem = FakeFileSystem()
        let digest = String(repeating: "a", count: 64)
        fileSystem.addFile(
            "/runtime/manifest.json",
            #"{"version":1,"entries":[{"path":"../escape","bytes":1,"sha256":"\#(digest)"}]}"#)
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifest(runtimeRoot: "/runtime", fileSystem: fileSystem)
        }
        #expect(error?.message.contains("invalid entry") == true)
    }

    @Test func missingOrUnsupportedManifestIsCorrupt() {
        let fileSystem = FakeFileSystem()
        #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifest(runtimeRoot: "/runtime", fileSystem: fileSystem)
        }
        fileSystem.addFile("/runtime/manifest.json", #"{"version":2,"entries":[]}"#)
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifest(runtimeRoot: "/runtime", fileSystem: fileSystem)
        }
        #expect(error?.message.contains("unsupported format") == true)
    }
}

@Suite struct PayloadToolDiscoveryTests {
    @Test func discoveryVerifiesThePayloadAndFindsTheBackend() throws {
        let harness = try Harness()
        var modes: [RuntimeVerificationMode] = []
        let tools = try RuntimePayload.discoverTools(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem,
            verification: { modes.append($0) })
        #expect(tools.compiledBackend == "\(testRuntimeRoot)/vision-backend")
        #expect(modes == [.full])
        // Discovery runs nothing: the backend opens SQLite itself, no server tools to probe.
        #expect(harness.runner.calls.isEmpty)
    }

    @Test func theBackendIsRequiredButNoAlembicBrowserOrDatabaseServerIs() throws {
        let harness = try Harness()
        // Today's payload has no Alembic runtime, no Chrome Headless Shell and no PostgreSQL.
        for retired in ["vision-alembic", "chromium/runtime.json", "postgres/runtime.json"] {
            #expect(harness.fileSystem.node("\(testRuntimeRoot)/\(retired)") == nil)
        }
        try harness.fileSystem.remove("\(testRuntimeRoot)/vision-backend")
        harness.writeManifest()
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.discoverTools(
                runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "BUN_NOT_FOUND")
    }
}

private let testMarkerPath = "\(testUserData)/native/\(RuntimeConstants.runtimeVerificationMarker)"

/// ADR-235: the first launch of an installed payload hashes every file; later launches with
/// the same manifest and location only check that the listed files exist with their sizes.
@Suite struct LaunchVerificationTests {
    @Test func theFirstLaunchHashesEverythingAndLaterLaunchesCheckSizes() throws {
        let harness = try Harness()
        let first = try RuntimePayload.verifyManifestOnLaunch(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        #expect(first.mode == .full)
        #expect(first.entries >= 6)
        let marker = try #require(harness.fileSystem.json(testMarkerPath))
        #expect(marker["version"] == .int(1))
        #expect(marker["runtimeRoot"] == .string(testRuntimeRoot))
        #expect(marker["entries"] == .int(first.entries))
        #expect(marker["appVersion"] == .null)
        #expect(try harness.fileSystem.mode(testMarkerPath) == 0o600)

        let second = try RuntimePayload.verifyManifestOnLaunch(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        #expect(second.mode == .cached)
        #expect(second.entries == first.entries)
    }

    @Test func aChangedSizeOrFileSetFallsBackToTheFullCheck() throws {
        let harness = try Harness()
        _ = try RuntimePayload.verifyManifestOnLaunch(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)

        harness.fileSystem.addFile("\(testRuntimeRoot)/vision-backend", "a longer backend", mode: 0o755)
        let resized = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifestOnLaunch(
                runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        }
        #expect(resized?.code == "NATIVE_RUNTIME_CORRUPT")

        harness.installPayload()
        harness.fileSystem.addFile("\(testRuntimeRoot)/db/migrations/0999_extra.sql", "-- extra\n")
        let unlisted = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.verifyManifestOnLaunch(
                runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        }
        #expect(unlisted?.message.contains("not covered") == true)
    }

    @Test func aNewManifestOrLocationInvalidatesTheMarker() throws {
        let harness = try Harness()
        _ = try RuntimePayload.verifyManifestOnLaunch(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)

        harness.fileSystem.addFile("\(testRuntimeRoot)/db/migrations/0131_next.sql", "-- next\n")
        harness.writeManifest()
        let updated = try RuntimePayload.verifyManifestOnLaunch(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        #expect(updated.mode == .full)
    }

    @Test func aMarkerThatCannotBeWrittenNeverBlocksStartup() throws {
        let harness = try Harness()
        // A directory in place of the marker file makes the write fail.
        harness.fileSystem.addDirectory(testMarkerPath)
        let result = try RuntimePayload.verifyManifestOnLaunch(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem)
        #expect(result.mode == .full)
    }
}
