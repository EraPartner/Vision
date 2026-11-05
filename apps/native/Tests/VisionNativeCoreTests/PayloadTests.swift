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
        #expect(count > RuntimeConstants.requiredPostgresTools.count)
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
        harness.fileSystem.addFile("\(testRuntimeRoot)/postgres/root/bin/extra", "x")
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

@Suite struct PayloadMetadataTests {
    @Test func postgresMetadataPinsVersionPlatformAndArchitecture() throws {
        let harness = try Harness()
        let bin = try RuntimePayload.postgresBinDirectory(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        #expect(bin == "\(testRuntimeRoot)/postgres/root/bin")

        harness.installPayload(postgresVersion: "18.5")
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.postgresBinDirectory(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "POSTGRES_RUNTIME_MISMATCH")
    }

    @Test func postgresBinPathMayNotEscape() throws {
        let fileSystem = FakeFileSystem()
        fileSystem.addFile(
            "/runtime/postgres/runtime.json",
            """
            {"version":1,"postgresMajor":18,"postgresVersion":"\(RuntimeConstants.postgresVersion)","platform":"darwin","architecture":"\(RuntimeConstants.payloadArchitecture)","binRelative":"../../bin"}
            """)
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.postgresBinDirectory(runtimeRoot: "/runtime", fileSystem: fileSystem)
        }
        #expect(error?.code == "POSTGRES_RUNTIME_MISMATCH")
    }

    @Test func missingPostgresMetadataMeansNoPackagedPostgres() throws {
        #expect(try RuntimePayload.postgresBinDirectory(runtimeRoot: "/runtime", fileSystem: FakeFileSystem()) == nil)
    }

    @Test func toolDiscoveryVerifiesVersionsAndFindsEveryTool() async throws {
        let harness = try Harness()
        let modes = LockedValue<[RuntimeVerificationMode]>([])
        let tools = try await RuntimePayload.discoverTools(
            runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem,
            runner: harness.runner, childEnvironment: ["PATH": "/usr/bin"],
            verification: { mode in modes.withLock { $0.append(mode) } })
        #expect(tools.binDirectory == "\(testRuntimeRoot)/postgres/root/bin")
        #expect(tools.compiledBackend == "\(testRuntimeRoot)/vision-backend")
        #expect(tools.versionNumbers["psql"] == 180_006)
        #expect(modes.withLock { $0 } == [.full])
        let checked = Set(harness.runner.calls.filter { $0.arguments == ["--version"] }.map(\.name))
        #expect(checked.isSuperset(of: RuntimeConstants.versionCheckedPostgresTools))
    }

    @Test func theBackendIsRequiredButNoAlembicOrBrowserIs() async throws {
        let harness = try Harness()
        // Today's payload has no Alembic runtime and no Chrome Headless Shell.
        for retired in ["vision-alembic", "chromium/runtime.json", "chromium/shell/chrome-headless-shell"] {
            #expect(harness.fileSystem.node("\(testRuntimeRoot)/\(retired)") == nil)
        }
        try harness.fileSystem.remove("\(testRuntimeRoot)/vision-backend")
        harness.writeManifest()
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await RuntimePayload.discoverTools(
                runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem,
                runner: harness.runner, childEnvironment: [:])
        }
        #expect(error?.code == "BUN_NOT_FOUND")
    }

    @Test func postgres17ToolsAreRejected() async throws {
        let harness = try Harness()
        harness.runner.handler = { call in
            call.arguments == ["--version"] ? RunResult(stdout: "\(call.name) (PostgreSQL) 17.4\n") : RunResult()
        }
        await #expect(throws: NativeRuntimeError.self) {
            try await RuntimePayload.discoverTools(
                runtimeRoot: testRuntimeRoot, markerPath: testMarkerPath, fileSystem: harness.fileSystem,
                runner: harness.runner, childEnvironment: [:])
        }
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
        #expect(first.entries > RuntimeConstants.requiredPostgresTools.count)
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
