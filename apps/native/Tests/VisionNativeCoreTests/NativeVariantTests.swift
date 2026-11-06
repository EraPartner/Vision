import Foundation
import Testing
@testable import VisionNativeCore

// The Demo variant (phase 1e): its own identity, directory and Keychain service.

@Suite struct NativeVariantTests {
    @Test func eachVariantHasItsOwnIdentity() {
        #expect(NativeVariant.standard.appName == "Vision Native")
        #expect(NativeVariant.standard.runtimeId == "vision_native")
        #expect(NativeVariant.standard.backupPassphraseService == KeychainPassphraseStore.standardService)
        #expect(NativeVariant.demo.appName == "Vision Native Demo")
        #expect(NativeVariant.demo.runtimeId == "vision_native_demo")
        #expect(NativeVariant.demo.backupPassphraseService == "com.vaultvoyager.vision-native-demo.backup-passphrase")
        #expect(
            NativeVariant.demo.userDataDirectory(homeDirectory: testHome)
                == "\(testHome)/Library/Application Support/Vision Native Demo")
        // Never an Electron runtime id or directory.
        for variant in NativeVariant.allCases {
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
        #expect(demo.variant == .demo)
        #expect(SupervisorConfiguration(environment: [:], homeDirectory: testHome, resourcesDirectory: nil).variant == .standard)
    }
}
