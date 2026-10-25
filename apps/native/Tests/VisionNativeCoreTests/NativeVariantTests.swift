import Foundation
import Testing
@testable import VisionNativeCore

// The Demo variant (phase 1e) and the audit bridge token the runtime gives the backend.

@Suite struct NativeVariantTests {
    @Test func eachVariantHasItsOwnIdentity() {
        #expect(NativeVariant.standard.appName == "Vision Native")
        #expect(NativeVariant.standard.runtimeId == "vision_native")
        #expect(NativeVariant.standard.postgresPort == 54331)
        #expect(NativeVariant.standard.backupPassphraseService == KeychainPassphraseStore.standardService)
        #expect(NativeVariant.standard.auditWitnessService == "com.vaultvoyager.vision-native.audit-witness")
        #expect(NativeVariant.standard.auditKeyService == "com.vaultvoyager.vision-native.audit-key")
        #expect(NativeVariant.demo.appName == "Vision Native Demo")
        #expect(NativeVariant.demo.runtimeId == "vision_native_demo")
        #expect(NativeVariant.demo.postgresPort == 54332)
        #expect(NativeVariant.demo.backupPassphraseService == "com.vaultvoyager.vision-native-demo.backup-passphrase")
        #expect(NativeVariant.demo.auditWitnessService == "com.vaultvoyager.vision-native-demo.audit-witness")
        #expect(NativeVariant.demo.auditKeyService == "com.vaultvoyager.vision-native-demo.audit-key")
        #expect(
            NativeVariant.demo.userDataDirectory(homeDirectory: testHome)
                == "\(testHome)/Library/Application Support/Vision Native Demo")
        // The witness service maps a runtime id the way Electron's helper does.
        #expect(KeychainAuditWitness.service(runtimeId: "vision_native_demo") == NativeVariant.demo.auditWitnessService)
        #expect(KeychainAuditWitness.service(runtimeId: "vision") == "com.vaultvoyager.vision.audit-witness")
        // Never an Electron port, runtime id or directory.
        for variant in NativeVariant.allCases {
            #expect(![54329, 54330].contains(variant.postgresPort))
            #expect(!["vision", "vision_demo"].contains(variant.runtimeId))
            #expect(!VisionNativeIdentity.foreignUserDataNames.contains(variant.userDataName))
        }
    }

    @Test func theInfoPlistValuePicksTheVariant() {
        #expect(NativeVariant.fromInfoPlist("demo") == .demo)
        #expect(NativeVariant.fromInfoPlist("standard") == .standard)
        #expect(NativeVariant.fromInfoPlist(nil) == .standard)
        #expect(NativeVariant.fromInfoPlist("$(VISION_NATIVE_VARIANT)") == .standard)
        #expect(NativeVariant.fromInfoPlist(1) == .standard)
    }

    @Test func layoutsAndSeedingStayInsideTheVariant() throws {
        let demo = try RuntimeLayout(variant: .demo, homeDirectory: testHome)
        #expect(demo.runtimeId == "vision_native_demo")
        #expect(demo.nativeRoot == "\(testHome)/Library/Application Support/Vision Native Demo/native/vision_native_demo")
        try NativeDemo.assertIsolation(demo)
        try NativeDemo.assertIsolation(try RuntimeLayout(variant: .standard, homeDirectory: testHome))
        // A variant's directory with the other variant's runtime id is refused.
        let crossed = try RuntimeLayout(
            userDataDirectory: NativeVariant.demo.userDataDirectory(homeDirectory: testHome), runtimeId: "vision_native")
        let error = #expect(throws: NativeRuntimeError.self) { try NativeDemo.assertIsolation(crossed) }
        #expect(error?.code == "DEMO_RUNTIME_UNSAFE")
        #expect(throws: NativeRuntimeError.self) {
            try RuntimeLayout(userDataDirectory: "\(testHome)/Library/Application Support/Vision Native Demo2")
        }
    }

    @Test func theSupervisorConfigurationFollowsTheVariant() {
        let demo = SupervisorConfiguration(
            environment: [:], homeDirectory: testHome, resourcesDirectory: nil, variant: .demo)
        #expect(demo.postgresPort == 54332)
        let pinned = SupervisorConfiguration(
            environment: [:], homeDirectory: testHome, resourcesDirectory: nil, postgresPort: 60000, variant: .demo)
        #expect(pinned.postgresPort == 60000)
        #expect(SupervisorConfiguration(environment: [:], homeDirectory: testHome, resourcesDirectory: nil).postgresPort == 54331)
    }
}

@Suite struct AuditBridgeTokenTests {
    private let token = String(repeating: "ab", count: 32)

    @Test func theTokenReachesTheBackendEnvironment() async throws {
        let harness = try Harness()
        let runtime = try NativeRuntime(
            layout: harness.layout, runtimeRoot: testRuntimeRoot, appPort: 41_000,
            inheritedEnvironment: ["PATH": "/usr/bin", "HOME": testHome, "VISION_AUDIT_BRIDGE_TOKEN": "inherited"],
            dependencies: harness.dependencies, auditBridgeToken: token)
        _ = try await runtime.start()
        let backend = try #require(harness.spawner.spawns.last)
        #expect(backend.environment["VISION_AUDIT_BRIDGE_TOKEN"] == token)
    }

    @Test func withoutATokenTheBackendHasNone() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime(
            environment: ["PATH": "/usr/bin", "HOME": testHome, "VISION_AUDIT_BRIDGE_TOKEN": "inherited"])
        _ = try await runtime.start()
        let backend = try #require(harness.spawner.spawns.last)
        #expect(backend.environment["VISION_AUDIT_BRIDGE_TOKEN"] == nil)
    }

    @Test func anInvalidTokenIsRefused() throws {
        let harness = try Harness()
        for invalid in ["", "AB" + String(repeating: "ab", count: 31), String(repeating: "ab", count: 31), token + "\n"] {
            let error = #expect(throws: NativeRuntimeError.self) {
                try NativeRuntime(
                    layout: harness.layout, runtimeRoot: testRuntimeRoot, appPort: 41_000, inheritedEnvironment: [:],
                    dependencies: harness.dependencies, auditBridgeToken: invalid)
            }
            #expect(error?.code == "INVALID_AUDIT_BRIDGE_TOKEN")
        }
    }

    @Test func aHealthyBackendFromAnEarlierLaunchIsRestartedForTheNewToken() async throws {
        let harness = try Harness()
        let first = try await harness.makeRuntime().start()
        guard case .started(let pid, _, _) = first else {
            Issue.record("expected a started backend")
            return
        }
        let runtime = try NativeRuntime(
            layout: harness.layout, runtimeRoot: testRuntimeRoot, appPort: 41_000,
            inheritedEnvironment: ["PATH": "/usr/bin", "HOME": testHome], dependencies: harness.dependencies,
            auditBridgeToken: token)
        let second = try await runtime.start()
        guard case .started(let replacement, _, _) = second else {
            Issue.record("expected a restarted backend, got \(second)")
            return
        }
        #expect(replacement != pid)
        #expect(harness.processes.sentSignals.map { $0.0 } == [pid])
        let backends = harness.spawner.spawns.filter { $0.executable.hasSuffix("vision-backend") }
        #expect(backends.count == 2)
        #expect(backends.last?.environment["VISION_AUDIT_BRIDGE_TOKEN"] == token)
    }

    @Test func theSupervisorGivesEachLaunchATokenAndAnAuditRuntime() async throws {
        let harness = try Harness()
        harness.installSeed()
        let backend = FakeAuditBackend()
        let tokens = StringBox()
        let supervisor = RuntimeSupervisor(
            configuration: SupervisorConfiguration(
                environment: ["PATH": "/usr/bin", "HOME": testHome, RuntimePayload.environmentKey: testRuntimeRoot],
                homeDirectory: testHome, resourcesDirectory: "/Applications/Vision Native.app/Contents/Resources",
                allowPayloadOverride: true,
                audit: AuditDependencies(
                    witness: MemoryAuditWitness(), keyProtector: NativeAuditKeyProtector(store: MemoryWrappingKeyStore()),
                    transport: { token, _ in
                        tokens.append(token)
                        return backend
                    })),
            dependencies: harness.dependencies, instanceLock: FakeInstanceLock(), logger: RecordingLog())
        // `AuditRuntime` is an actor, not Equatable: test for absence without `==`.
        let before = await supervisor.auditRuntime()
        let hadRuntimeBefore = before.map { _ in true } ?? false
        #expect(!hadRuntimeBefore)
        _ = try await supervisor.launch()
        let audit = await supervisor.auditRuntime()
        let hasRuntime = audit.map { _ in true } ?? false
        #expect(hasRuntime)
        let token = try #require(tokens.values.first)
        #expect(PathUtilities.fullMatch(token, "[0-9a-f]{64}"))
        let spawned = try #require(harness.spawner.spawns.last { $0.executable.hasSuffix("vision-backend") })
        #expect(spawned.environment["VISION_AUDIT_BRIDGE_TOKEN"] == token)
        await supervisor.shutdown()
        let after = await supervisor.auditRuntime()
        let hasRuntimeAfter = after.map { _ in true } ?? false
        #expect(!hasRuntimeAfter)
    }
}
