import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct PayloadLocationTests {
    @Test func environmentOverrideWinsAndPointsAtTheSeedSibling() throws {
        let harness = try Harness()
        let location = try RuntimePayload.locate(
            environment: [RuntimePayload.environmentKey: testRuntimeRoot + "/"],
            resourcesDirectory: "/Applications/Vision Native.app/Contents/Resources",
            fileSystem: harness.fileSystem)
        #expect(location.source == .environment)
        #expect(location.runtimeDirectory == testRuntimeRoot)
        #expect(location.demoSeedDirectory == testSeedRoot)
    }

    @Test func relativeOrEmptyOverrideIsRejected() throws {
        let harness = try Harness()
        #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [RuntimePayload.environmentKey: "payload/native-runtime"], resourcesDirectory: nil,
                fileSystem: harness.fileSystem)
        }
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [RuntimePayload.environmentKey: "/payload/missing"], resourcesDirectory: nil,
                fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "NATIVE_RUNTIME_MISSING")
    }

    @Test func appBundleResourcesAreUsedWithoutAnOverride() throws {
        let fileSystem = FakeFileSystem()
        let resources = "/Applications/Vision Native.app/Contents/Resources"
        fileSystem.addFile("\(resources)/runtime/manifest.json", #"{"version":1,"entries":[]}"#)
        let location = try RuntimePayload.locate(
            environment: [:], resourcesDirectory: resources, fileSystem: fileSystem)
        #expect(location.source == .appBundle)
        #expect(location.runtimeDirectory == "\(resources)/runtime")
        #expect(location.demoSeedDirectory == "\(resources)/demo-seed")
    }

    @Test func missingPayloadGivesAnActionableError() {
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.locate(
                environment: [:], resourcesDirectory: "/Applications/Vision Native.app/Contents/Resources",
                fileSystem: FakeFileSystem())
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

    @Test func chromiumMetadataPinsTheShellVersion() throws {
        let harness = try Harness()
        let chrome = try RuntimePayload.chromiumExecutable(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        #expect(chrome == "\(testRuntimeRoot)/chromium/shell/chrome-headless-shell")

        harness.fileSystem.addFile(
            "\(testRuntimeRoot)/chromium/runtime.json",
            #"{"version":1,"browser":"chrome-headless-shell","browserVersion":"1.0","platform":"darwin","architecture":"arm64","executableRelative":"shell/chrome-headless-shell"}"#
        )
        let error = #expect(throws: NativeRuntimeError.self) {
            try RuntimePayload.chromiumExecutable(runtimeRoot: testRuntimeRoot, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "CHROMIUM_RUNTIME_MISMATCH")
    }

    @Test func toolDiscoveryVerifiesVersionsAndFindsEveryTool() async throws {
        let harness = try Harness()
        let tools = try await RuntimePayload.discoverTools(
            runtimeRoot: testRuntimeRoot, environment: [:], fileSystem: harness.fileSystem, runner: harness.runner,
            childEnvironment: ["PATH": "/usr/bin"])
        #expect(tools.binDirectory == "\(testRuntimeRoot)/postgres/root/bin")
        #expect(tools.compiledBackend == "\(testRuntimeRoot)/vision-backend")
        #expect(tools.alembic == "\(testRuntimeRoot)/vision-alembic")
        #expect(tools.chrome == "\(testRuntimeRoot)/chromium/shell/chrome-headless-shell")
        #expect(tools.versionNumbers["psql"] == 180_006)
        let checked = Set(harness.runner.calls.filter { $0.arguments == ["--version"] }.map(\.name))
        #expect(checked.isSuperset(of: RuntimeConstants.versionCheckedPostgresTools))
    }

    @Test func postgres17ToolsAreRejected() async throws {
        let harness = try Harness()
        harness.runner.handler = { call in
            call.arguments == ["--version"] ? RunResult(stdout: "\(call.name) (PostgreSQL) 17.4\n") : RunResult()
        }
        await #expect(throws: NativeRuntimeError.self) {
            try await RuntimePayload.discoverTools(
                runtimeRoot: testRuntimeRoot, environment: [:], fileSystem: harness.fileSystem,
                runner: harness.runner, childEnvironment: [:])
        }
    }
}
